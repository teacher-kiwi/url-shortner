'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

// 서버가 환경 변수(BASE_URL, TIME_ZONE)로 채워 넣는 값.
const HOST = document.body.dataset.host;
const TIME_ZONE = document.body.dataset.timeZone;

let links = [];
let sortKey = 'created';

// ---------------------------------------------------------------- API

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/admin';
    throw new Error('로그인이 필요해요.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청에 실패했어요.');
  return data;
}

// ---------------------------------------------------------------- 표시 도우미

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 화면에는 한글 그대로 보여준다 (https:// 는 생략).
function displayUrl(link) {
  return `${HOST}/${link.slug}`;
}

function fmtDateTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('ko-KR', {
    timeZone: TIME_ZONE, year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtAgo(iso) {
  if (!iso) return '아직 없음';
  const sec = (Date.now() - new Date(iso)) / 1000;
  if (sec < 60) return '방금';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}일 전`;
  return fmtDateTime(iso);
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function localToday() {
  return dayFormat.format(new Date());
}

function daysUntil(day) {
  return Math.round((Date.parse(day) - Date.parse(localToday())) / 864e5);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http 로 열었을 때 등 clipboard API 가 막힌 경우
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('복사했어요! 📋');
}

// 복사는 사람이 읽을 수 있는 한글 주소로 한다.
function copyValue(link) {
  return link.short_url.replace(/\/[^/]*$/, '/') + link.slug;
}

// ---------------------------------------------------------------- 목록

async function load() {
  const data = await api('GET', '/links');
  links = data.links;
  render();
}

function sorted(list) {
  const by = {
    created: (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
    clicks: (a, b) => b.clicks - a.clicks || b.id - a.id,
    recent: (a, b) => (b.last_clicked_at || '').localeCompare(a.last_clicked_at || '') || b.id - a.id,
  }[sortKey];
  return [...list].sort(by);
}

function expiryTag(link) {
  if (!link.expires_at) return '';
  if (link.expired) return `<span class="tag expired">만료됨 (${esc(link.expires_at)})</span>`;
  const d = daysUntil(link.expires_at);
  if (d <= 3) return `<span class="tag soon">${d === 0 ? '오늘까지' : `${d}일 남음`}</span>`;
  return `<span class="tag until">${esc(link.expires_at)}까지</span>`;
}

function render() {
  $('#sum-links').textContent = links.length.toLocaleString();
  $('#sum-clicks').textContent = links.reduce((s, l) => s + l.clicks, 0).toLocaleString();
  $('#sum-today').textContent = links.reduce((s, l) => s + l.today, 0).toLocaleString();

  const term = $('#search').value.trim().toLowerCase();
  const shown = sorted(links).filter((l) =>
    !term || [l.slug, l.url, l.memo].some((v) => v.toLowerCase().includes(term)));

  $('#empty').hidden = links.length > 0;
  $('#list').innerHTML = shown.map((l) => `
    <article class="card link-card ${l.expired ? 'is-expired' : ''}" data-id="${l.id}">
      <div class="link-top">
        <div class="slug"><small>${esc(HOST)}/</small>${esc(l.slug)}</div>
        <div class="clicks"><b>${l.clicks.toLocaleString()}</b><span>접속</span></div>
      </div>
      <div class="dest">→ <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.url)}">${esc(l.url)}</a></div>
      ${l.memo ? `<div class="memo">${esc(l.memo)}</div>` : ''}
      <div class="meta">
        <span class="tag" title="${esc(fmtDateTime(l.last_clicked_at) || '')}">최근 접속 · ${esc(fmtAgo(l.last_clicked_at))}</span>
        ${l.today ? `<span class="tag">오늘 ${l.today}</span>` : ''}
        ${expiryTag(l)}
      </div>
      <div class="actions">
        <button class="btn btn-sm btn-primary" data-act="copy">복사</button>
        <button class="btn btn-sm btn-lime" data-act="qr">QR</button>
        <button class="btn btn-sm btn-cyan" data-act="stats">통계</button>
        <button class="btn btn-sm" data-act="edit">수정</button>
        <button class="btn btn-sm btn-danger" data-act="delete">삭제</button>
      </div>
    </article>`).join('');

  if (links.length && !shown.length) {
    $('#list').innerHTML = '<p class="empty card">검색 결과가 없어요.</p>';
  }
}

$('#search').addEventListener('input', render);

$('.toolbar .sort').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sort]');
  if (!btn) return;
  sortKey = btn.dataset.sort;
  for (const b of e.currentTarget.children) b.classList.toggle('active', b === btn);
  render();
});

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const link = links.find((l) => l.id === Number(btn.closest('[data-id]').dataset.id));
  if (!link) return;

  switch (btn.dataset.act) {
    case 'copy': return copyText(copyValue(link));
    case 'qr': return openQr(link);
    case 'stats': return openStats(link);
    case 'edit': return openEdit(link);
    case 'delete':
      if (!confirm(`'${link.slug}' 링크를 삭제할까요?\n접속 기록도 함께 지워지고 되돌릴 수 없어요.`)) return;
      try {
        await api('DELETE', `/links/${link.id}`);
        links = links.filter((l) => l.id !== link.id);
        render();
        toast('삭제했어요.');
      } catch (err) {
        alert(err.message);
      }
  }
});

// ---------------------------------------------------------------- 만들기

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('button[type=submit]', form);
  const errEl = $('#create-error');
  errEl.hidden = true;
  btn.disabled = true;
  try {
    const link = await api('POST', '/links', Object.fromEntries(new FormData(form)));
    links.unshift(link);
    render();
    form.reset();
    showCreated(link);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

function showCreated(link) {
  const box = $('#create-result');
  box.innerHTML = `
    <span class="badge">완성!</span>
    <span class="new-url">${esc(displayUrl(link))}</span>
    <button class="btn btn-sm btn-primary" data-act="copy">복사</button>
    <button class="btn btn-sm btn-lime" data-act="qr">QR</button>`;
  box.hidden = false;
  box.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'copy') copyText(copyValue(link));
    if (act === 'qr') openQr(link);
  };
  copyText(copyValue(link));
}

// ---------------------------------------------------------------- 모달

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    // 바깥(배경) 클릭이나 닫기 버튼으로 닫는다.
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  });
}

// --- QR

let qrLink = null;

function openQr(link) {
  qrLink = link;
  $('#qr-img').src = `/api/links/${link.id}/qr.svg?v=${encodeURIComponent(link.slug)}`;
  $('#qr-url').textContent = displayUrl(link);
  $('#qr-download').href = `/api/links/${link.id}/qr.png?download=1`;
  $('#qr-dialog').showModal();
}

// 교실 화면용 전체 화면. 모달을 닫고 별도 화면을 띄운다.
$('#qr-full').addEventListener('click', async () => {
  const view = document.createElement('div');
  view.className = 'qr-fullview';
  view.innerHTML = `<img src="${$('#qr-img').src}" alt="QR 코드"><p>${esc(displayUrl(qrLink))}</p><small>클릭하거나 ESC 로 닫기</small>`;
  document.body.append(view);
  $('#qr-dialog').close();
  const leave = () => { if (document.fullscreenElement) document.exitFullscreen(); view.remove(); };
  view.addEventListener('click', leave);
  try {
    await view.requestFullscreen();
    view.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) view.remove(); });
  } catch {
    // 전체 화면이 안 되는 브라우저(아이폰 등)는 화면을 꽉 채운 레이어로 대신한다.
  }
});

// --- 통계

let statsLink = null;

async function openStats(link) {
  statsLink = link;
  $('#stats-title').textContent = `/${link.slug} 접속 통계`;
  const active = $('#stats-dialog .sort .active');
  $('#stats-dialog').showModal();
  await drawStats(Number(active.dataset.days));
}

$('#stats-dialog .sort').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-days]');
  if (!btn) return;
  for (const b of e.currentTarget.children) b.classList.toggle('active', b === btn);
  drawStats(Number(btn.dataset.days));
});

async function drawStats(days) {
  const chart = $('#chart');
  chart.innerHTML = '';
  $('#stats-sum').textContent = '불러오는 중…';
  chart.nextElementSibling?.classList.contains('chart-axis') && chart.nextElementSibling.remove();

  const { link, series } = await api('GET', `/links/${statsLink.id}/stats?days=${days}`);
  const total = series.reduce((s, d) => s + d.count, 0);
  const max = Math.max(1, ...series.map((d) => d.count));
  const today = localToday();

  $('#stats-sum').innerHTML = `
    최근 ${days}일 <b>${total.toLocaleString()}</b>회 · 전체 <b>${link.clicks.toLocaleString()}</b>회<br>
    <small>최근 접속: ${esc(fmtDateTime(link.last_clicked_at) || '아직 없음')} · 만든 날: ${esc(fmtDateTime(link.created_at))}</small>`;

  chart.innerHTML = series.map((d) => {
    const h = d.count ? Math.max(4, (d.count / max) * 100) : 100;
    const cls = ['bar', d.count ? '' : 'zero', d.day === today ? 'today' : ''].join(' ');
    return `<div class="${cls}" style="height:${h}%"><span class="tip">${d.day.slice(5).replace('-', '/')} · ${d.count}회</span></div>`;
  }).join('');

  const axis = document.createElement('div');
  axis.className = 'chart-axis';
  axis.innerHTML = `<span>${series[0].day.slice(5).replace('-', '/')}</span><span>최대 ${max}회</span><span>오늘</span>`;
  chart.after(axis);
}

// --- 수정

let editLink = null;

function openEdit(link) {
  editLink = link;
  const form = $('#edit-form');
  form.slug.value = link.slug;
  form.url.value = link.url;
  form.memo.value = link.memo;
  form.expires_at.value = link.expires_at || '';
  $('#edit-error').hidden = true;
  $('#edit-dialog').showModal();
}

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#edit-error');
  errEl.hidden = true;
  try {
    const updated = await api('PATCH', `/links/${editLink.id}`, Object.fromEntries(new FormData(e.currentTarget)));
    const today = editLink.today;
    links = links.map((l) => (l.id === updated.id ? { ...updated, today } : l));
    render();
    $('#edit-dialog').close();
    toast('저장했어요.');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

// ---------------------------------------------------------------- 시작

load().catch((err) => alert(err.message));
// 띄워두면 접속 수가 저절로 올라가도록 30초마다 새로 고친다.
setInterval(() => {
  if (!document.hidden && !document.querySelector('dialog[open]')) load().catch(() => {});
}, 30000);
