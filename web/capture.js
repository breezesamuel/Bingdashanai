// web/capture.js — 设备采集：拍照 / 视频录制 / 屏幕录制
// 用 getUserMedia + MediaRecorder，零依赖。产出可下载、可直接送入音视频流水线。
// 诚实红线：无摄像头权限时如实提示，不假装已采集。
const CAP = (() => {
  const $ = s => document.querySelector(s);
  let stream = null, recorder = null, chunks = [], mode = null;

  function log(msg) {
    const el = $('#capLog');
    if (el) { el.hidden = false; el.textContent = (el.textContent ? el.textContent + '\n' : '') + msg; }
  }

  async function listCams() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs.filter(d => d.kind === 'videoinput');
      const sel = $('#capCam');
      if (sel) {
        // 用 DOM API 而非 innerHTML 拼接：摄像头 label 来自设备/OS，
        // 不可信输入直接进 innerHTML 会给注入留缝。
        sel.replaceChildren();
        cams.forEach((c, i) => {
          const opt = document.createElement('option');
          opt.value = c.deviceId;
          opt.textContent = c.label || ('摄像头 ' + (i + 1));
          sel.appendChild(opt);
        });
      }
      return cams.length;
    } catch (e) { return 0; }
  }

  async function open(deviceId) {
    stop();
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    const v = $('#capPreview');
    if (v) { v.srcObject = stream; v.hidden = false; v.play().catch(() => {}); }
    $('#capActions').hidden = false;
    await listCams();
    return stream;
  }

  function stop() {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
    recorder = null; chunks = [];
    try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    stream = null;
    const v = $('#capPreview');
    if (v) { v.srcObject = null; v.hidden = true; }
    $('#capActions').hidden = true;
  }

  function pickMime() {
    const cands = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    for (const m of cands) { if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m; }
    return '';
  }

  // 拍照
  async function photo() {
    try {
      if (!stream) await open($('#capCam') && $('#capCam').value);
      const v = $('#capPreview');
      if (!v || !v.videoWidth) return log('❌ 摄像头未就绪');
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      c.toBlob(b => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = 'photo-' + Date.now() + '.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        log('✅ 照片已拍摄并下载（' + c.width + 'x' + c.height + '）');
      }, 'image/png');
    } catch (e) { log('❌ 拍照失败：' + (e.message || e) + '\n提示：需在设置里允许摄像头权限'); }
  }

  // 录像
  async function record() {
    try {
      if (!stream) await open($('#capCam') && $('#capCam').value);
      if (!window.MediaRecorder) return log('❌ 当前环境不支持 MediaRecorder');
      chunks = [];
      recorder = new MediaRecorder(stream, { mimeType: pickMime() || undefined });
      recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'video-' + Date.now() + '.webm';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        log('✅ 视频已录制并下载（' + (blob.size / 1048576).toFixed(1) + ' MB）');
      };
      recorder.start();
      mode = 'video';
      log('🎥 开始录制…（再点"停止录制"结束）');
    } catch (e) { log('❌ 录制失败：' + (e.message || e)); }
  }

  // 录屏
  async function screen() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return log('❌ 当前环境不支持屏幕录制');
      stop();
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const v = $('#capPreview');
      if (v) { v.srcObject = stream; v.hidden = false; v.play().catch(() => {}); }
      $('#capActions').hidden = false;
      chunks = [];
      recorder = new MediaRecorder(stream, { mimeType: pickMime() || undefined });
      recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'screen-' + Date.now() + '.webm';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        log('✅ 录屏已保存（' + (blob.size / 1048576).toFixed(1) + ' MB）');
      };
      recorder.start();
      mode = 'screen';
      log('🖥 开始录屏…（选区域后点"停止录制"）');
    } catch (e) { log('❌ 录屏失败：' + (e.message || e)); }
  }

  function stopRec() {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
    log('⏹ 已停止');
  }

  function boot() {
    const bind = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    bind('#capPhoto', photo);
    bind('#capVideo', record);
    bind('#capScreen', screen);
    bind('#capSnap', photo);
    bind('#capStop', stopRec);
    // 摄像头切换
    const sel = $('#capCam');
    if (sel) sel.onchange = () => open(sel.value).catch(e => log('❌ 切换失败：' + e.message));
    // 文件转换
    bind('#cvGo', async () => {
      const f = $('#cvFile') && $('#cvFile').files[0];
      const t = $('#cvTarget') && $('#cvTarget').value;
      const out = $('#cvResult');
      if (!f) { if (out) { out.hidden = false; out.textContent = '请先选择文件'; } return; }
      if (out) { out.hidden = false; out.textContent = '转换中…（首次使用需从 CDN 加载库，稍等）'; }
      try {
        const r = await window.CONV.convert(f, t);
        if (!r.ok) { if (out) out.textContent = '❌ ' + r.error; return; }
        window.CONV.download(r, f.name.replace(/\.[^.]+$/, ''));
        if (out) out.textContent = '✅ 转换完成，已开始下载' + (r.warn ? '\n提示：' + r.warn : '') + (r.content ? '\n\n预览：\n' + r.content.slice(0, 800) : '');
      } catch (e) { if (out) out.textContent = '❌ 转换失败：' + (e.message || e); }
    });
  }

  return { boot, photo, record, screen, stopRec, listCams };
})();

window.CAP = CAP;
document.addEventListener('DOMContentLoaded', () => { try { CAP.boot(); } catch (e) {} });
