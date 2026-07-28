// vault_inject.js — In-page autofill badge + form detection + save capture.
// Injected at document start via adblock_inject.rs.
// Communicates with the chrome via Tauri events (window.__TAURI__.emit).

(function () {
  'use strict';

  // ─── Configuration ──────────────────────────────────────────────
  var BADGE_SIZE = 24;
  var BADGE_OFFSET = 4;
  var DEBOUNCE_MS = 200;
  var CURRENT_BADGE = null;
  var CURRENT_DROPDOWN = null;
  var AUTOFILL_DATA = null;
  var LAST_DETECTED_DOMAIN = null;
  var DETECTION_DEBOUNCE = null;

  // ─── Skip non-HTTP origins ──────────────────────────────────────
  if (!window.location.protocol.startsWith('http')) return;

  // ─── Tauri event helpers ────────────────────────────────────────
  function emit(channel, payload) {
    try {
      if (window.__TAURI__ && window.__TAURI__.emit) {
        window.__TAURI__.emit(channel, payload);
      }
    } catch (e) {}
  }

  function listen(channel, cb) {
    try {
      if (window.__TAURI__ && window.__TAURI__.listen) {
        window.__TAURI__.listen(channel, function (evt) {
          cb(evt.payload);
        });
      }
    } catch (e) {}
  }

  // ─── Form Detection (MutationObserver) ─────────────────────────
  function detectPasswordFields() {
    var pwInputs = document.querySelectorAll('input[type="password"]');
    var results = [];
    for (var i = 0; i < pwInputs.length; i++) {
      var input = pwInputs[i];
      // Find associated username field (previous sibling text/email input in same form)
      var usernameField = null;
      var form = input.closest('form');
      if (form) {
        var inputs = form.querySelectorAll('input');
        for (var j = 0; j < inputs.length; j++) {
          if (inputs[j] === input) break;
          var type = (inputs[j].type || '').toLowerCase();
          if (type === 'text' || type === 'email') {
            usernameField = inputs[j];
          }
        }
      }
      results.push({ passwordField: input, usernameField: usernameField });
    }
    return results;
  }

  function notifyFormState() {
    var fields = detectPasswordFields();
    var hasLoginForm = fields.length > 0;
    var domain = window.location.hostname;

    if (hasLoginForm !== (LAST_DETECTED_DOMAIN !== null)) {
      LAST_DETECTED_DOMAIN = hasLoginForm ? domain : null;
      emit('form:formStateChanged', {
        hasLoginForm: hasLoginForm,
        domain: domain,
        tabId: 0, // Will be set by the chrome if needed
      });
    }

    // Position badge on the first password field
    if (hasLoginForm && fields.length > 0) {
      positionBadge(fields[0].passwordField, fields);
    } else {
      removeBadge();
    }
  }

  // ─── Badge Rendering ────────────────────────────────────────────
  function createBadge() {
    if (CURRENT_BADGE) return CURRENT_BADGE;

    var badge = document.createElement('div');
    badge.id = '__aegis_autofill_badge';
    badge.style.cssText = [
      'position: fixed',
      'z-index: 2147483647',
      'width: ' + BADGE_SIZE + 'px',
      'height: ' + BADGE_SIZE + 'px',
      'border-radius: 4px',
      'background: #f0f0f0',
      'border: 1px solid #ccc',
      'cursor: pointer',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'box-shadow: 0 1px 3px rgba(0,0,0,0.2)',
      'transition: background 0.15s',
      'pointer-events: auto',
    ].join('; ');

    // Key icon SVG
    badge.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';

    badge.addEventListener('mouseenter', function () {
      badge.style.background = '#e0e0e0';
    });
    badge.addEventListener('mouseleave', function () {
      badge.style.background = '#f0f0f0';
    });
    badge.addEventListener('click', handleBadgeClick);

    document.body.appendChild(badge);
    CURRENT_BADGE = badge;
    return badge;
  }

  function positionBadge(passwordField, allFields) {
    var badge = createBadge();
    var rect = passwordField.getBoundingClientRect();
    badge.style.left = rect.right - BADGE_SIZE - BADGE_OFFSET + 'px';
    badge.style.top = rect.top + (rect.height - BADGE_SIZE) / 2 + 'px';
    badge.style.display = 'flex';

    // Store field references for fill
    badge._passwordField = passwordField;
    badge._usernameField = allFields[0] ? allFields[0].usernameField : null;
    badge._allFields = allFields;
  }

  function removeBadge() {
    if (CURRENT_BADGE) {
      CURRENT_BADGE.style.display = 'none';
    }
    removeDropdown();
  }

  // ─── Badge Click Handler ────────────────────────────────────────
  function handleBadgeClick(e) {
    e.stopPropagation();
    e.preventDefault();

    if (!AUTOFILL_DATA) {
      // No credentials available — nothing to do
      return;
    }

    if (AUTOFILL_DATA.count === 1) {
      // Smart fill: single match → fill immediately
      var label = AUTOFILL_DATA.labels[0];
      requestFillFromChrome(label.username);
    } else if (AUTOFILL_DATA.count > 1) {
      // Multiple matches → show dropdown
      showDropdown(AUTOFILL_DATA.labels);
    }
  }

  // ─── Dropdown (multiple credentials) ────────────────────────────
  function showDropdown(labels) {
    removeDropdown();

    var badge = CURRENT_BADGE;
    if (!badge) return;

    var dropdown = document.createElement('div');
    dropdown.id = '__aegis_autofill_dropdown';
    dropdown.style.cssText = [
      'position: fixed',
      'z-index: 2147483647',
      'background: white',
      'border: 1px solid #ddd',
      'border-radius: 6px',
      'box-shadow: 0 4px 12px rgba(0,0,0,0.15)',
      'max-height: 200px',
      'overflow-y: auto',
      'min-width: 180px',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'font-size: 13px',
    ].join('; ');

    var badgeRect = badge.getBoundingClientRect();
    dropdown.style.left = badgeRect.left + 'px';
    dropdown.style.top = badgeRect.bottom + 4 + 'px';

    labels.forEach(function (label) {
      var item = document.createElement('div');
      item.style.cssText = 'padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #eee;';
      item.innerHTML =
        '<div style="font-weight: 500;">' +
        escapeHtml(label.username) +
        '</div>' +
        '<div style="color: #888; font-size: 11px;">' +
        escapeHtml(label.site) +
        '</div>';
      item.addEventListener('mouseenter', function () {
        item.style.background = '#f5f5f5';
      });
      item.addEventListener('mouseleave', function () {
        item.style.background = 'white';
      });
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        removeDropdown();
        requestFillFromChrome(label.username);
      });
      dropdown.appendChild(item);
    });

    document.body.appendChild(dropdown);
    CURRENT_DROPDOWN = dropdown;

    // Close on outside click
    setTimeout(function () {
      document.addEventListener('click', removeDropdown, { once: true });
    }, 0);
  }

  function removeDropdown() {
    if (CURRENT_DROPDOWN) {
      CURRENT_DROPDOWN.remove();
      CURRENT_DROPDOWN = null;
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Fill Mechanics ─────────────────────────────────────────────
  function requestFillFromChrome(username) {
    // Request fill data from chrome (one-time password delivery)
    emit('vault:requestFill', { username: username });
  }

  function fillField(field, value) {
    if (!field) return;

    // Set value using native setter (React-compatible)
    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    nativeInputValueSetter.call(field, value);

    // Dispatch events to trigger framework bindings
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  function fillCredentials(username, password) {
    var badge = CURRENT_BADGE;
    if (!badge) return;

    if (badge._usernameField) {
      fillField(badge._usernameField, username);
    }
    fillField(badge._passwordField, password);

    // Clear the fill data after use
    AUTOFILL_DATA = null;
    removeBadge();
  }

  // ─── Save Capture (form submission) ─────────────────────────────
  function setupFormSubmitCapture() {
    document.addEventListener(
      'submit',
      function (e) {
        var form = e.target;
        if (!(form instanceof HTMLFormElement)) return;

        // Find password field in the form
        var pwInput = form.querySelector('input[type="password"]');
        if (!pwInput) return;

        // Find username field
        var usernameInput = null;
        var inputs = form.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) {
          if (inputs[i] === pwInput) break;
          var type = (inputs[i].type || '').toLowerCase();
          if (type === 'text' || type === 'email') {
            usernameInput = inputs[i];
          }
        }

        var username = usernameInput ? usernameInput.value : '';
        var password = pwInput.value;
        var domain = window.location.hostname;

        if (password) {
          emit('form:willSubmit', {
            domain: domain,
            username: username,
            password: password,
          });
        }
      },
      true,
    ); // Use capture phase to get the event before navigation
  }

  // ─── Listen for fill data from chrome ───────────────────────────
  listen('vault:autofillResult', function (data) {
    if (data && data.username && data.password) {
      fillCredentials(data.username, data.password);
    }
  });

  // Listen for badge data from chrome
  listen('vault:autofillData', function (data) {
    AUTOFILL_DATA = data;
    // Update badge if visible
    if (CURRENT_BADGE && CURRENT_BADGE.style.display !== 'none') {
      if (data && data.count > 0) {
        CURRENT_BADGE.style.display = 'flex';
      } else {
        CURRENT_BADGE.style.display = 'none';
      }
    }
  });

  // ─── Initialize ─────────────────────────────────────────────────
  // Initial detection
  notifyFormState();

  // Watch for DOM changes
  var observer = new MutationObserver(function () {
    if (DETECTION_DEBOUNCE) clearTimeout(DETECTION_DEBOUNCE);
    DETECTION_DEBOUNCE = setTimeout(notifyFormState, DEBOUNCE_MS);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'autocomplete'],
  });

  // Watch for scroll/resize to reposition badge
  window.addEventListener(
    'scroll',
    function () {
      if (CURRENT_BADGE && CURRENT_BADGE.style.display !== 'none') {
        var fields = detectPasswordFields();
        if (fields.length > 0) {
          positionBadge(fields[0].passwordField, fields);
        }
      }
    },
    { passive: true },
  );

  window.addEventListener(
    'resize',
    function () {
      if (CURRENT_BADGE && CURRENT_BADGE.style.display !== 'none') {
        var fields = detectPasswordFields();
        if (fields.length > 0) {
          positionBadge(fields[0].passwordField, fields);
        }
      }
    },
    { passive: true },
  );

  // Setup form submission capture
  setupFormSubmitCapture();
})();
