/**
 * Client-side form-submit handler — the meno-astro twin of meno-core's
 * `formHandlerScript` (`packages/core/lib/client/scripts/formHandler.ts`).
 *
 * A Meno `<Form submitHandler="fetch">` renders `<form data-submit-handler="fetch"
 * data-success-message=… data-error-message=…>` with a `<div data-form-message>`
 * placeholder. meno-core's SSR injects this handler so the form submits via `fetch`
 * (FormData → the form's `action`, e.g. a Cloudflare `/api/send-email` function) and
 * shows the success/error message inline instead of navigating the browser to the
 * endpoint's raw JSON response.
 *
 * BaseLayout.astro injects this before `</body>`. Kept HERE (not imported from
 * meno-core) for the same reason as `toHtmlString`/`richText`: it must ship with the
 * locally-rebuilt play runtime, and a converted project depends only on `meno-astro`
 * + `astro` (not `meno-core`), so a meno-core import would not resolve at the user's
 * build. Keep behaviour in parity with the meno-core original.
 *
 * Self-executing IIFE string, emitted verbatim inside `<script is:inline>`. It is a
 * no-op when the page has no `form[data-submit-handler="fetch"]`, so injecting it on
 * every page is harmless (Astro renders <head> before the body, so the layout can't
 * cheaply detect forms — unconditional + self-gating is the robust choice).
 */
export const formHandlerScript = `
(function () {
  var forms = document.querySelectorAll('form[data-submit-handler="fetch"]');
  if (!forms.length) return;

  // Spam protection (server-enforced at /api/send-email): inject a hidden honeypot
  // field bots fill but humans never see, and stamp a clock-skew-free dwell time on
  // submit. Fields named with a leading "_" are control/meta and are not emailed.
  var loadedAt = Date.now();

  forms.forEach(function (form) {
    if (!form.querySelector('input[name="_honey"]')) {
      var hp = document.createElement('input');
      hp.type = 'text';
      hp.name = '_honey';
      hp.tabIndex = -1;
      hp.setAttribute('autocomplete', 'off');
      hp.setAttribute('aria-hidden', 'true');
      hp.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0';
      form.appendChild(hp);
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();

      var action = form.getAttribute('action');
      var method = form.getAttribute('method') || 'POST';
      var successMessage = form.getAttribute('data-success-message') || 'Form submitted successfully!';
      var errorMessage = form.getAttribute('data-error-message') || 'Something went wrong. Please try again.';

      var messageEl = form.querySelector('[data-form-message]');
      if (!messageEl) {
        messageEl = document.createElement('div');
        messageEl.setAttribute('data-form-message', 'true');
        form.appendChild(messageEl);
      }

      var submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      var originalBtnText = submitBtn ? (submitBtn.textContent || submitBtn.value) : '';
      if (submitBtn) {
        submitBtn.disabled = true;
        if (submitBtn.tagName === 'BUTTON') submitBtn.textContent = 'Sending...';
        else submitBtn.value = 'Sending...';
      }

      messageEl.style.display = 'none';

      function showMessage(text, ok) {
        messageEl.textContent = text;
        messageEl.style.display = 'block';
        messageEl.style.backgroundColor = ok ? '#d4edda' : '#f8d7da';
        messageEl.style.color = ok ? '#155724' : '#721c24';
        messageEl.style.border = '1px solid ' + (ok ? '#c3e6cb' : '#f5c6cb');
      }

      try {
        var body = new FormData(form);
        body.append('_elapsed', String(Date.now() - loadedAt));
        var response = await fetch(action, { method: method.toUpperCase(), body: body });
        var data = await response.json().catch(function () { return {}; });
        if (response.ok && data.success) {
          showMessage(data.message || successMessage, true);
          form.reset();
        } else {
          showMessage(data.error || errorMessage, false);
        }
      } catch (err) {
        showMessage(errorMessage, false);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          if (submitBtn.tagName === 'BUTTON') submitBtn.textContent = originalBtnText;
          else submitBtn.value = originalBtnText;
        }
      }
    });
  });
})();
`;
