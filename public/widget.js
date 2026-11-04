/*
 * Donate widget. Paste on any website:
 *   <script src="https://<organization address>/widget.js" data-campaign="1001" async></script>
 * Options on the script tag:
 *   data-mode="button" (default) shows a Donate button that opens the form in a window over the page;
 *   data-mode="inline" puts the form right where the script is.
 *   data-label="Give now" and data-color="#4f46e5" style the button.
 * The form itself is the campaign's payment page, served from the organization's address in a frame,
 * so card details go to Sola from there and never touch the host site.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var base = script.src.replace(/\/widget\.js.*$/, '');
  var campaign = script.getAttribute('data-campaign');
  if (!campaign) { console.warn('Donate widget: add data-campaign="<campaign number>" to the script tag'); return; }
  var org = script.getAttribute('data-org');
  var mode = script.getAttribute('data-mode') || 'button';
  var color = script.getAttribute('data-color') || '#4f46e5';
  var label = script.getAttribute('data-label') || 'Donate';
  var src = base + '/embed' + (org ? '?org=' + encodeURIComponent(org) : '') + '#/give/' + encodeURIComponent(campaign);

  function frame(height) {
    var f = document.createElement('iframe');
    f.src = src;
    f.title = 'Donation form';
    f.setAttribute('allow', 'payment');
    f.style.cssText = 'width:100%;border:0;display:block;height:' + height + ';background:#f5f6f8;';
    // The form reports its height so an inline frame never scrolls inside the page.
    window.addEventListener('message', function (e) {
      if (e.origin !== base || !e.data || e.data.type !== 'oizer-give-height' || e.source !== f.contentWindow) return;
      if (mode === 'inline') f.style.height = Math.ceil(e.data.height) + 'px';
    });
    return f;
  }

  if (mode === 'inline') {
    var holder = document.createElement('div');
    holder.style.cssText = 'max-width:680px;margin:0 auto;';
    holder.appendChild(frame('900px'));
    script.parentNode.insertBefore(holder, script.nextSibling);
    return;
  }

  var button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.cssText = 'background:' + color + ';color:#fff;border:0;border-radius:8px;padding:12px 22px;font:600 16px/1.2 Arial,Helvetica,sans-serif;cursor:pointer;';
  button.addEventListener('click', function () {
    var back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:rgba(15,17,25,.55);z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;width:100%;max-width:680px;height:min(92vh,960px);background:#f5f6f8;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);';
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.style.cssText = 'position:absolute;top:6px;right:8px;z-index:1;width:36px;height:36px;border:0;border-radius:50%;background:rgba(255,255,255,.9);font:24px/36px Arial,sans-serif;cursor:pointer;color:#111;';
    var f = frame('100%');
    box.appendChild(close);
    box.appendChild(f);
    back.appendChild(box);
    function shut() { document.body.removeChild(back); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') shut(); }
    close.addEventListener('click', shut);
    back.addEventListener('click', function (e) { if (e.target === back) shut(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(back);
  });
  script.parentNode.insertBefore(button, script.nextSibling);
})();
