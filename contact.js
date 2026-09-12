/**
 * Contact / Feature Request widget.
 *
 * One implementation for every page. index.html, privacy.html and terms.html all define
 * the same handful of CSS variables (--ground, --surface, --hair, --ink, --muted, --faint,
 * --accent), so the widget is styled from those and looks native on each without importing
 * anything. Everything it needs — styles, markup, behaviour — is injected from here, so a
 * page only has to load the script.
 *
 *   <script src="./contact.js" defer></script>
 *
 * Any element carrying data-contact-open becomes a trigger. If a page has none, a button is
 * added just before its footer, which is where the one on dupsweep.com sits.
 *
 * Posts to api/contact relative to the page, so it works from the app and from the two
 * static policy pages, which live in the same directory.
 */
(function () {
  if (window.__contactWidget) return;
  window.__contactWidget = true;

  var CSS = [
    '.cw-btn{font:inherit;font-size:14px;font-weight:500;padding:10px 20px;border-radius:8px;',
    '  border:1px solid var(--hair);background:var(--accent);color:#fff;cursor:pointer}',
    '.cw-btn:hover{opacity:.9}',
    '.cw-foot{margin:40px 0 0;text-align:center}',
    '.cw-foot p{margin:0 0 12px;font-size:13.5px;color:var(--muted)}',
    '.cw-modal{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px}',
    '.cw-modal[hidden]{display:none}',
    '.cw-back{position:absolute;inset:0;background:rgba(10,12,16,.55)}',
    '.cw-card{position:relative;z-index:1;width:100%;max-width:520px;max-height:88vh;overflow-y:auto;',
    '  background:var(--surface);color:var(--ink);border:1px solid var(--hair);border-radius:14px;',
    '  box-shadow:0 10px 40px rgba(10,12,16,.28);padding:22px}',
    '.cw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:4px}',
    '.cw-head h2{margin:0;font-size:19px;font-weight:600;color:var(--ink);font-family:inherit}',
    '.cw-x{background:none;border:0;font-size:26px;line-height:1;cursor:pointer;color:var(--muted);padding:0 2px}',
    '.cw-x:hover{color:var(--ink)}',
    '.cw-sub{margin:0 0 16px;font-size:13px;color:var(--muted)}',
    '.cw-f{margin-bottom:13px}',
    '.cw-f label{display:block;margin-bottom:5px;font-size:12.5px;font-weight:500;color:var(--ink)}',
    '.cw-f input,.cw-f select,.cw-f textarea{width:100%;padding:9px 11px;border:1px solid var(--hair);',
    '  border-radius:7px;font-family:inherit;font-size:14px;background:var(--ground);color:var(--ink)}',
    '.cw-f textarea{resize:vertical;min-height:110px}',
    '.cw-f input:focus,.cw-f select:focus,.cw-f textarea:focus{outline:none;border-color:var(--accent)}',
    '.cw-act{display:flex;gap:10px;margin-top:18px}',
    '.cw-act button{flex:1;padding:11px 16px;border-radius:8px;font:inherit;font-size:14px;font-weight:500;cursor:pointer}',
    '.cw-send{border:0;background:var(--accent);color:#fff}',
    '.cw-cancel{border:1px solid var(--hair);background:var(--surface);color:var(--ink)}',
    '.cw-act button[disabled]{opacity:.6;cursor:default}',
    '.cw-note{margin:12px 0 0;font-size:13px;min-height:18px}',
    '.cw-note.ok{color:#3f8f5b}.cw-note.err{color:#c0473e}'
  ].join('');

  var HTML =
    '<div class="cw-back" data-cw-close></div>' +
    '<div class="cw-card" role="dialog" aria-modal="true" aria-labelledby="cw-title">' +
      '<div class="cw-head">' +
        '<h2 id="cw-title">Contact / Feature Request</h2>' +
        '<button type="button" class="cw-x" data-cw-close aria-label="Close">&times;</button>' +
      '</div>' +
      '<p class="cw-sub">Support questions or ideas for a new feature. Replies go to the address you give here.</p>' +
      '<form id="cw-form" novalidate>' +
        '<div class="cw-f"><label for="cw-type">Type</label>' +
          '<select id="cw-type"><option value="support">Support</option>' +
          '<option value="feature">Feature Request</option></select></div>' +
        '<div class="cw-f"><label for="cw-name">Name</label>' +
          '<input type="text" id="cw-name" placeholder="Your name" autocomplete="name" required></div>' +
        '<div class="cw-f"><label for="cw-email">E-mail</label>' +
          '<input type="email" id="cw-email" placeholder="you@example.com" autocomplete="email" required></div>' +
        '<div class="cw-f"><label for="cw-title-f">Title</label>' +
          '<input type="text" id="cw-title-f" placeholder="Subject" required></div>' +
        '<div class="cw-f"><label for="cw-msg">Description</label>' +
          '<textarea id="cw-msg" placeholder="What happened, or what would you like it to do?" required></textarea></div>' +
        '<div class="cw-act">' +
          '<button type="submit" class="cw-send" id="cw-send">Send</button>' +
          '<button type="button" class="cw-cancel" data-cw-close>Cancel</button>' +
        '</div>' +
        '<p class="cw-note" id="cw-note"></p>' +
      '</form>' +
    '</div>';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var modal = document.createElement('div');
    modal.className = 'cw-modal';
    modal.id = 'cw-modal';
    modal.hidden = true;
    modal.innerHTML = HTML;
    document.body.appendChild(modal);

    var form = modal.querySelector('#cw-form');
    var note = modal.querySelector('#cw-note');
    var send = modal.querySelector('#cw-send');
    var lastFocus = null;

    function open() {
      lastFocus = document.activeElement;
      form.reset();
      note.textContent = ''; note.className = 'cw-note';
      send.disabled = false; send.textContent = 'Send';
      modal.hidden = false;
      var first = modal.querySelector('#cw-name');
      if (first) setTimeout(function () { first.focus(); }, 30);
    }
    function close() {
      modal.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    modal.addEventListener('click', function (e) {
      if (e.target.hasAttribute && e.target.hasAttribute('data-cw-close')) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) close();
    });

    // Any existing button or link can drive it; nothing has to move.
    var triggers = document.querySelectorAll('[data-contact-open]');
    Array.prototype.forEach.call(triggers, function (t) {
      t.addEventListener('click', function (e) { e.preventDefault(); open(); });
    });

    // A page with no trigger of its own gets one before its footer, so every page has a way in.
    if (!triggers.length) {
      var foots = document.querySelectorAll('footer');
      var anchor = foots.length ? foots[foots.length - 1] : null;
      var block = document.createElement('div');
      block.className = 'cw-foot';
      block.innerHTML = '<p>Something not working, or an idea for the app?</p>' +
        '<button type="button" class="cw-btn">Contact / Feature Request</button>';
      block.querySelector('button').addEventListener('click', open);
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(block, anchor);
      else document.body.appendChild(block);
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = {
        type: modal.querySelector('#cw-type').value,
        name: modal.querySelector('#cw-name').value.trim(),
        email: modal.querySelector('#cw-email').value.trim(),
        title: modal.querySelector('#cw-title-f').value.trim(),
        message: modal.querySelector('#cw-msg').value.trim()
      };
      if (!body.name || !body.email || !body.title || !body.message) {
        note.className = 'cw-note err';
        note.textContent = 'Every field is needed before this can be sent.';
        return;
      }
      send.disabled = true; send.textContent = 'Sending…';
      note.className = 'cw-note'; note.textContent = '';

      fetch('api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.d.success) throw new Error((res.d && res.d.error) || 'send failed');
          note.className = 'cw-note ok';
          note.textContent = res.d.message || 'Sent — thanks, you will hear back at that address.';
          send.textContent = 'Sent';
          setTimeout(close, 2200);
        })
        .catch(function () {
          send.disabled = false; send.textContent = 'Send';
          note.className = 'cw-note err';
          note.textContent = 'That did not send. Try again, or email singleuseapp@gmail.com directly.';
        });
    });
  });
})();
