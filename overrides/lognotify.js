/*
 * 买家来消息 → 网页内弹窗提醒
 * ============================================================
 * 本地新增功能，不依赖钉钉/微信/Bark 等任何第三方服务。
 *
 * 原理：
 *   这个系统本身已经有一条实时通道 —— 后端在收到闲鱼 IM 推送后会通过
 *   WebSocket 把消息转发给前端（在线聊天页用的就是它）。本脚本复用同一条
 *   通道，对每个已启用账号各开一条连接，收到 isSelf === false（即买家发来）
 *   的消息时，在页面右下角弹出提醒，并播放提示音 + 闪烁标签页标题。
 *
 * 接口依赖（都来自系统本身，非外部服务）：
 *   账号列表  GET  /api/v1/cookies/options
 *   实时消息  WS   /api/v1/chat-new/ws/<账号ID>?token=<登录令牌>
 *   登录令牌  localStorage['auth_token']（与前端共用，自动跟随登录状态）
 */
(function () {
  'use strict';
  if (window.__znbMsgNotify) return;   // 防止重复注入
  window.__znbMsgNotify = true;

  var KEEP_MAX = 5;          // 同时最多显示几条
  var HOLD_MS = 30000;       // 每条停留时间
  var RELOAD_MS = 60000;     // 重新拉账号列表的间隔
  var RETRY_MS = 5000;       // 断线重连间隔

  // ---------------- 样式 ----------------
  var style = document.createElement('style');
  style.textContent = [
    '#znb-notify-host{position:fixed;right:16px;bottom:16px;z-index:2147483647;',
    'display:flex;flex-direction:column;gap:10px;width:330px;pointer-events:none;',
    'font-family:inherit;font-size:13px;line-height:1.55}',
    '.znb-card{pointer-events:auto;cursor:pointer;border-radius:12px;padding:12px 14px;',
    'background:#fff;color:#1f2328;border-left:4px solid #f5c800;',
    'box-shadow:0 10px 30px rgba(0,0,0,.22);animation:znbIn .22s ease-out}',
    '.znb-dark .znb-card{background:#22272e;color:#e6edf3;box-shadow:0 10px 30px rgba(0,0,0,.5)}',
    '.znb-head{display:flex;align-items:baseline;gap:8px;font-weight:700;margin-bottom:4px}',
    '.znb-who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.znb-acc{font-weight:400;opacity:.6;font-size:11px;white-space:nowrap}',
    '.znb-close{opacity:.45;padding:0 2px;font-weight:400}',
    '.znb-close:hover{opacity:1}',
    '.znb-body{white-space:pre-wrap;word-break:break-word;max-height:6.6em;overflow:hidden}',
    '.znb-btn{margin-top:8px;display:inline-block;padding:5px 12px;border-radius:8px;',
    'border:1px solid currentColor;background:transparent;color:inherit;font-size:12px;',
    'font-weight:600;cursor:pointer;opacity:.85}',
    '.znb-btn:hover{opacity:1}',
    '@keyframes znbIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}'
  ].join('');
  (document.head || document.documentElement).appendChild(style);

  // ---------------- 容器 ----------------
  var host = null;
  function ensureHost() {
    if (host && document.body && document.body.contains(host)) return host;
    host = document.getElementById('znb-notify-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'znb-notify-host';
      (document.body || document.documentElement).appendChild(host);
    }
    return host;
  }

  // ---------------- 提示音（WebAudio，无需任何音频文件） ----------------
  var audioCtx = null;

  // 浏览器要求"先有用户交互"才允许播放声音。如果页面从头到尾没被点过，
  // AudioContext 会一直是 suspended，提示音会被静默拦掉 —— 表现就是
  // "弹窗出来了但没声音"。这里在第一次点击/按键/触摸时就把音频解锁。
  function unlockAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      // 语音播报也需要一次用户交互才能解锁，否则第一次来消息时不会出声
      if (window.speechSynthesis && !window.__znbSpeechReady) {
        window.__znbSpeechReady = true;
        try {
          var warm = new window.SpeechSynthesisUtterance(' ');
          warm.volume = 0;
          window.speechSynthesis.speak(warm);
        } catch (e2) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
    document.removeEventListener('click', unlockAudio, true);
    document.removeEventListener('keydown', unlockAudio, true);
    document.removeEventListener('touchstart', unlockAudio, true);
  }

  // ---------------- 语音播报 ----------------
  // 用浏览器内置的语音合成（Windows 自带中文语音），不依赖任何第三方。
  // 只播报"有新消息 + 来自谁"，不念消息正文 —— 一是在外面可能不方便外放，
  // 二是长文本会拖很久，反而耽误你看内容。
  var SPEAK_ENABLED = true;

  function speak(msg) {
    if (!SPEAK_ENABLED || !window.speechSynthesis) return;
    try {
      var text = '闲鱼有新消息';
      if (msg && msg.senderName) text += '，来自 ' + msg.senderName;
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.05;
      u.pitch = 1;
      u.volume = 1;
      // 取消上一条，避免消息密集时排队念一大堆
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  }
  document.addEventListener('click', unlockAudio, true);
  document.addEventListener('keydown', unlockAudio, true);
  document.addEventListener('touchstart', unlockAudio, true);

  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t0 = audioCtx.currentTime;
      // 音色与节奏保持原样：两声正弦波 880Hz → 1180Hz，间隔 0.16 秒。
      // 只把峰值音量从 0.2 提到 0.9（约 4.5 倍），这是唯一改动。
      // 纯正弦波不存在谐波破音问题，接近满幅也不会失真；
      // 若觉得刺耳，把下面两个 0.9 调小即可（0.5 大约等于原来的一半）。
      [880, 1180].forEach(function (freq, i) {
        var t = t0 + i * 0.16;
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.9, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.15);
      });
    } catch (e) { /* 浏览器未授权音频时静默忽略 */ }
  }

  // ---------------- 标签页标题闪烁（页面在后台时也能看到） ----------------
  var flashTimer = null;
  var baseTitle = null;
  function startFlash() {
    if (flashTimer) return;
    baseTitle = document.title;
    var on = false;
    flashTimer = setInterval(function () {
      on = !on;
      document.title = on ? '🔔 有新消息' : baseTitle;
    }, 1200);
  }
  function stopFlash() {
    if (!flashTimer) return;
    clearInterval(flashTimer);
    flashTimer = null;
    if (baseTitle !== null) document.title = baseTitle;
  }
  window.addEventListener('focus', stopFlash);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) stopFlash();
  });

  // ---------------- 弹窗 ----------------
  // 桌面通知：浏览器自带的 Notification API，非第三方软件。
  // 只在页面处于后台/最小化时弹，避免你正看着页面时被重复打扰。
  // 有些内置浏览器（例如 Codex 应用内浏览器、部分精简内核）根本没有 Notification
  // 对象，或者有对象但没实现 requestPermission。这种情况直接当作不支持，
  // 连"开启"按钮都不要显示，免得点了一直没反应。
  function notifySupported() {
    return !!(window.Notification &&
      typeof window.Notification.requestPermission === 'function');
  }

  function desktopNotify(msg, accountLabel) {
    if (!notifySupported()) return;
    if (window.Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    try {
      var n = new window.Notification(
        '💬 ' + (msg.senderName || '买家') + ' · ' + accountLabel,
        {
          body: describe(msg),
          tag: 'znb-' + accountLabel + '-' + (msg.time || Date.now()),
          renotify: false
        }
      );
      n.onclick = function () {
        try { window.focus(); } catch (e) { /* 忽略 */ }
        try { window.location.href = '/online-chat-new'; } catch (e) { /* 忽略 */ }
        n.close();
      };
    } catch (e) { /* 某些环境下构造通知会抛错，忽略即可 */ }
  }

  // 首次进入时给一个「开启桌面通知」按钮。必须由用户点击才能申请权限，
  // 浏览器不允许页面自己静默弹权限框。
  function ensurePermissionPrompt() {
    if (!notifySupported()) return;
    if (window.Notification.permission !== 'default') return;
    var h = ensureHost();
    if (h.querySelector('.znb-perm')) return;

    var card = document.createElement('div');
    card.className = 'znb-card znb-perm';

    var head = document.createElement('div');
    head.className = 'znb-head';
    var who = document.createElement('span');
    who.className = 'znb-who';
    who.textContent = '🔔 开启桌面通知';
    var close = document.createElement('span');
    close.className = 'znb-close';
    close.textContent = '✕';
    head.appendChild(who);
    head.appendChild(close);

    var body = document.createElement('div');
    body.className = 'znb-body';
    body.textContent = '开启后，即使浏览器切到后台或最小化，Windows 右下角也会弹出新消息提醒。';

    var btn = document.createElement('button');
    btn.className = 'znb-btn';
    btn.textContent = '开启';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        var p = window.Notification.requestPermission();
        if (p && typeof p.then === 'function') {
          p.then(function () { card.remove(); }, function () { card.remove(); });
        } else {
          card.remove();
        }
      } catch (err) {
        // 走到这里说明虽然对象存在但实际调不动 —— 如实告诉用户，别让人干等
        body.textContent = '这个浏览器调不动桌面通知，请改用 Chrome 或 Edge 打开本页面。';
        btn.remove();
      }
    });

    close.addEventListener('click', function (e) {
      e.stopPropagation();
      card.remove();
    });

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(btn);
    h.appendChild(card);
  }

  function describe(msg) {
    if (!msg) return '（空消息）';
    if (msg.text) return msg.text;
    var t = msg.type;
    if (t === 'image') return '[图片]';
    if (t === 'audio' || t === 'voice') return '[语音]';
    if (t === 'video') return '[视频]';
    if (t === 'file') return '[文件]';
    return '[' + (t || '新消息') + ']';
  }

  function popup(accountLabel, msg) {
    var h = ensureHost();
    while (h.children.length >= KEEP_MAX) h.removeChild(h.firstChild);

    var card = document.createElement('div');
    card.className = 'znb-card';

    var head = document.createElement('div');
    head.className = 'znb-head';
    var who = document.createElement('span');
    who.className = 'znb-who';
    who.textContent = '💬 ' + (msg.senderName || '买家');
    var acc = document.createElement('span');
    acc.className = 'znb-acc';
    acc.textContent = accountLabel;
    var close = document.createElement('span');
    close.className = 'znb-close';
    close.textContent = '✕';
    head.appendChild(who);
    head.appendChild(acc);
    head.appendChild(close);

    var body = document.createElement('div');
    body.className = 'znb-body';
    body.textContent = describe(msg);

    card.appendChild(head);
    card.appendChild(body);
    close.addEventListener('click', function (e) {
      e.stopPropagation();
      card.remove();
    });
    card.addEventListener('click', function () {
      // 跳到「在线聊天」页，方便直接回复
      try {
        window.location.href = '/online-chat-new';
      } catch (e) { /* 忽略 */ }
    });

    h.appendChild(card);
    beep();
    speak(msg);
    startFlash();
    desktopNotify(msg, accountLabel);
    setTimeout(function () { if (card.parentNode) card.remove(); }, HOLD_MS);
  }

  // ---------------- WebSocket 订阅 ----------------
  var sockets = {};   // accountId -> WebSocket

  function getToken() {
    try { return localStorage.getItem('auth_token') || ''; } catch (e) { return ''; }
  }

  function buildWsUrl(accountId) {
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + window.location.host +
      '/api/v1/chat-new/ws/' + encodeURIComponent(accountId) +
      '?token=' + encodeURIComponent(getToken());
  }

  function connect(accountId, label) {
    var old = sockets[accountId];
    if (old && (old.readyState === 0 || old.readyState === 1)) return;
    if (!getToken()) return;

    var ws;
    try { ws = new WebSocket(buildWsUrl(accountId)); } catch (e) { return; }
    sockets[accountId] = ws;

    var ping = setInterval(function () {
      if (ws.readyState !== 1) return;
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { /* 忽略 */ }
    }, 25000);

    ws.addEventListener('message', function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.event !== 'new_message') return;
      var msg = data.message;
      if (!msg) return;
      if (msg.isSelf) return;          // 只关心买家发来的，不弹自己发出去的
      popup(label, msg);
    });

    ws.addEventListener('close', function () {
      clearInterval(ping);
      if (sockets[accountId] === ws) delete sockets[accountId];
      setTimeout(function () { connect(accountId, label); }, RETRY_MS);
    });

    ws.addEventListener('error', function () {
      try { ws.close(); } catch (e) { /* 忽略 */ }
    });
  }

  // ---------------- 拉账号列表并订阅 ----------------
  function subscribeAll() {
    if (!getToken()) return;   // 还没登录，等下一轮
    fetch('/api/v1/cookies/options', {
      headers: { Authorization: 'Bearer ' + getToken() }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (list) {
        if (!Array.isArray(list)) return;
        list.forEach(function (acc) {
          if (!acc || !acc.id) return;
          if (acc.enabled === false) return;                    // 暂停的账号不订阅
          var label = acc.remark ? (acc.remark + ' · ' + acc.id) : acc.id;
          connect(acc.id, label);
        });
      })
      .catch(function () { /* 忽略，下一轮重试 */ });
  }

  function boot() {
    ensurePermissionPrompt();
    subscribeAll();
    setInterval(subscribeAll, RELOAD_MS);
    // 页面从后台切回前台时立刻补一次（顺便让音频上下文获得用户交互授权）
    window.addEventListener('focus', subscribeAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
