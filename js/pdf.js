// Turn a rendered quote/invoice (<article class="doc">) into a real PDF file,
// so it can be attached automatically when sharing. Libraries are vendored and
// loaded only when needed (works offline once cached).

let libs;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the PDF tools. Check your connection and retry.'));
    document.head.appendChild(s);
  });
}
function loadLibs() {
  libs ??= Promise.all([loadScript('js/vendor/html2canvas.min.js'), loadScript('js/vendor/jspdf.umd.min.js')]);
  return libs;
}

// docHtml: the inner HTML of an <article class="doc">. Rendered off-screen at letter width.
export async function makePdf(docHtml, { brand = '#1f5f3f' } = {}) {
  await loadLibs();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:816px;z-index:-1;pointer-events:none';
  host.innerHTML = `<article class="doc pdf" style="--brand:${brand};max-width:none;width:816px;box-shadow:none;border-radius:0">${docHtml}</article>`;
  document.body.appendChild(host);
  try {
    const doc = host.firstElementChild;
    await Promise.all([...doc.querySelectorAll('img')].map((img) => (img.complete ? 0 : new Promise((r) => { img.onload = img.onerror = r; }))));
    const W = doc.offsetWidth;
    const H = doc.offsetHeight;
    // iOS caps canvas size around 16.7M pixels.
    const scale = Math.min(2, Math.sqrt(16e6 / (W * H)));
    const canvas = await window.html2canvas(doc, { scale, backgroundColor: '#ffffff', useCORS: true, logging: false, windowWidth: 816 });

    // Page breaks: prefer the bottom of a row/paragraph/section over cutting through text.
    const top = doc.getBoundingClientRect().top;
    const inAvoid = (el) => el.parentElement?.closest('.avoid');
    const after = [...doc.querySelectorAll('tr, li, p, .avoid, .meta, .dh, .tot, .terms, .sign, .foot')]
      .filter((el) => !inAvoid(el) && !(el.tagName === 'TR' && !el.previousElementSibling)) // keep table headers with a row
      .map((el) => el.getBoundingClientRect().bottom - top);
    const before = [...doc.querySelectorAll('.sec, .avoid')] // break *before* headings and photo blocks
      .filter((el) => !inAvoid(el))
      .map((el) => el.getBoundingClientRect().top - top - 4);
    const breaks = [...after, ...before].filter((v) => v > 0).sort((a, b) => a - b);

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
    const pageW = 612;
    const pageH = 792;
    const ptPerPx = pageW / W;
    const margin = 36; // top/bottom margin on continuation pages, in pt
    let y = 0;
    let page = 0;
    while (y < H - 2) {
      const usable = (page === 0 ? pageH - margin : pageH - margin * 2) / ptPerPx;
      let end = Math.min(H, y + usable);
      if (end < H) {
        const good = breaks.filter((b) => b > y + usable * 0.5 && b <= end);
        if (good.length) end = good[good.length - 1] + 2;
      }
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = Math.max(1, Math.round((end - y) * scale));
      slice.getContext('2d').drawImage(canvas, 0, Math.round(y * scale), canvas.width, slice.height, 0, 0, canvas.width, slice.height);
      if (page) pdf.addPage();
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', 0, page === 0 ? 0 : margin, pageW, (end - y) * ptPerPx);
      y = end;
      page++;
    }
    return pdf.output('blob');
  } finally {
    host.remove();
  }
}
