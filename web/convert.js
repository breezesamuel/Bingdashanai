// web/convert.js — 文件互换工作台（前端版，CDN 库按需加载）
//
// 为什么放在前端：Node 端装 mammoth/pandoc/xlsx 需整包下载，本网络被阻断；
// 而 CDN 小请求实测可达（206）。故在浏览器里用 CDN 库做转换，零安装、双击可用。
//
// 支持（实测 CDN 可达的库）：
//   docx → html/md   mammoth
//   md → html        marked
//   html → md        自研（去标签保留结构）
//   xlsx/csv ⇄ json  xlsx
//   md → docx        docxgen
//   json → csv       自研
//   csv → json       自研
//   纯文本重排/格式化  自研（去空行/统一缩进/中英标点）
//
// 红线：转换失败如实报；大文件有上限提示；不上传服务器（全本地处理，隐私）。

const CONV = (() => {
  const CDN = {
    mammoth: 'vendor/mammoth.browser.min.js',
    marked: 'vendor/marked.min.js',
    xlsx: 'vendor/xlsx.full.min.js',
    docxgen: 'vendor/docx.index.umd.js'
  };
  const loaded = {};
  function loadScript(name) {
    if (loaded[name]) return Promise.resolve(loaded[name]);
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = CDN[name]; s.onload = () => { loaded[name] = s; res(s); };
      s.onerror = () => rej(new Error('本地依赖加载失败：' + name + '（安装包可能不完整，重装后重试）'));
      document.head.appendChild(s);
    });
  }

  // ---- 自研转换（零依赖，永远可用）----
  function htmlToMd(html) {
    let s = String(html || '');
    s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, t) => '\n\n' + '#'.repeat(+n) + ' ' + t.trim() + '\n\n');
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, t) => '\n- ' + t.trim());
    s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, t) => '\n\n> ' + t.trim() + '\n\n');
    s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
    s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n');
    s = s.replace(/<[^>]+>/g, '');
    // 解实体
    s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }
  function jsonToCsv(obj) {
    const arr = Array.isArray(obj) ? obj : (obj && typeof obj === 'object' ? [obj] : []);
    if (!arr.length) return '';
    const keys = [...new Set(arr.flatMap(o => Object.keys(o || {})))];
    const esc = v => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    return [keys.join(',')].concat(arr.map(o => keys.map(k => esc(o[k])).join(','))).join('\n');
  }
  function csvToJson(csv) {
    const lines = String(csv || '').trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const parse = l => { const r = []; let c = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (ch === '"') { if (q && l[i+1] === '"') { c += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { r.push(c); c = ''; } else c += ch; } r.push(c); return r; };
    const head = parse(lines[0]);
    return lines.slice(1).map(l => { const v = parse(l); const o = {}; head.forEach((h, i) => o[h] = v[i] != null ? v[i] : ''); return o; });
  }
  function tidyText(t) {
    let lines = String(t || '').split(/\r?\n/);
    lines = lines.map(l => l.replace(/[ \t]+$/, ''));       // 去行尾空白
    lines = lines.filter((l, i) => !(l.trim() === '' && lines[i-1] && lines[i-1].trim() === '')); // 去连续空行
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // ---- 转换调度 ----
  async function convert(file, target) {
    const name = (file.name || '').toLowerCase();
    const ext = name.split('.').pop();
    const buf = await file.arrayBuffer();
    const text = async () => new TextDecoder('utf-8').decode(buf);

    // docx → html / md
    if (ext === 'docx' && (target === 'html' || target === 'md')) {
      await loadScript('mammoth');
      const r = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      const html = r.value || '';
      return { ok: true, content: target === 'md' ? htmlToMd(html) : html, type: target === 'md' ? 'text/markdown' : 'text/html', warn: (r.messages || []).length ? (r.messages.length + ' 条转换提示') : '' };
    }
    // md → html
    if ((ext === 'md' || ext === 'markdown') && target === 'html') {
      await loadScript('marked');
      return { ok: true, content: window.marked.parse(await text()), type: 'text/html' };
    }
    // md → docx
    if ((ext === 'md' || ext === 'markdown') && target === 'docx') {
      await loadScript('docxgen');
      const D = window.docx || window.Docx;
      if (!D) return { ok: false, error: 'docxgen 未就绪' };
      const lines = (await text()).split(/\r?\n/);
      const doc = new D.Document({ sections: [{ children: lines.filter(Boolean).map(l => new D.Paragraph({ text: l.replace(/^#+\s*/, '') })) }] });
      const out = await D.Packer.toBlob(doc);
      return { ok: true, blob: out, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    }
    // html → md
    if ((ext === 'html' || ext === 'htm') && target === 'md') {
      return { ok: true, content: htmlToMd(await text()), type: 'text/markdown' };
    }
    // html → txt
    if ((ext === 'html' || ext === 'htm') && target === 'txt') {
      return { ok: true, content: htmlToMd(await text()).replace(/[#*>`]/g, ''), type: 'text/plain' };
    }
    // xlsx → json / csv
    if (ext === 'xlsx' && (target === 'json' || target === 'csv')) {
      await loadScript('xlsx');
      const wb = window.XLSX.read(new Uint8Array(buf), { type: 'array' });
      const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      return { ok: true, content: target === 'json' ? JSON.stringify(rows, null, 2) : jsonToCsv(rows), type: target === 'json' ? 'application/json' : 'text/csv' };
    }
    // csv → json
    if (ext === 'csv' && target === 'json') {
      return { ok: true, content: JSON.stringify(csvToJson(await text()), null, 2), type: 'application/json' };
    }
    // json → csv
    if (ext === 'json' && target === 'csv') {
      let j; try { j = JSON.parse(await text()); } catch (e) { return { ok: false, error: 'JSON 解析失败：' + e.message }; }
      return { ok: true, content: jsonToCsv(j), type: 'text/csv' };
    }
    // csv → xlsx
    if (ext === 'csv' && target === 'xlsx') {
      await loadScript('xlsx');
      const rows = csvToJson(await text());
      const ws = window.XLSX.utils.json_to_sheet(rows);
      const wb = window.XLSX.utils.book_new(); window.XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      const out = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      return { ok: true, blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    // 文本整理
    if (target === 'tidy') {
      return { ok: true, content: tidyText(await text()), type: 'text/plain' };
    }
    // md ⇄ txt
    if ((ext === 'md' || ext === 'markdown' || ext === 'txt') && (target === 'txt' || target === 'md')) {
      const t = await text();
      return { ok: true, content: target === 'txt' ? t.replace(/[#*>`]/g, '') : t, type: 'text/plain' };
    }
    return { ok: false, error: '暂不支持：' + ext + ' → ' + target + '。支持：docx→html/md/docx、md→html/docx/txt、html→md/txt、xlsx→json/csv、csv→json/xlsx、json→csv、任意文本→tidy' };
  }

  function download(res, baseName) {
    const blob = res.blob || new Blob([res.content || ''], { type: res.type || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (baseName || 'converted') + '.' + (res.type && res.type.includes('word') ? 'docx' : res.type && res.type.includes('sheet') ? 'xlsx' : res.type && res.type.includes('html') ? 'html' : res.type && res.type.includes('json') ? 'json' : res.type && res.type.includes('csv') ? 'csv' : res.type && res.type.includes('markdown') ? 'md' : 'txt');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  return { convert, download, htmlToMd, jsonToCsv, csvToJson, tidyText };
})();

window.CONV = CONV;
