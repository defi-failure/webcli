(function() {
  'use strict';

  var PROTOCOL_VERSION = 1;

  var state = {
    openerOrigin: null,
    request: null,
    walletInfo: null,
    balance: null,
    responded: false,
    readyTimer: null,
    readyAttempts: 0,
    openedAt: Date.now(),
  };

  function $(id) { return document.getElementById(id); }

  function setLoadingStatus(msg) {
    var el = $('loading-status');
    if (el) el.textContent = msg;
  }

  function showView(id) {
    ['view-loading','view-no-wallet','view-locked','view-approve','view-result','view-error']
      .forEach(function(v) { $(v).style.display = (v === id) ? '' : 'none'; });
  }

  async function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var r = await fetch(path, opts);
    var text = await r.text();
    var j;
    try { j = JSON.parse(text); } catch (e) {
      throw new Error('bad response: ' + text.slice(0, 80));
    }
    if (!r.ok) throw new Error(j.error || ('http ' + r.status));
    return j;
  }

  function fmtAddr(a) {
    if (!a || a.length < 12) return a || '';
    return a.slice(0, 10) + '...' + a.slice(-6);
  }

  function rawToOct(raw) {
    var s = String(raw == null ? '0' : raw).replace(/[^0-9]/g, '');
    if (!s || s === '0') return '0';
    while (s.length <= 6) s = '0' + s;
    var intP = s.slice(0, s.length - 6);
    var fracP = s.slice(-6).replace(/0+$/, '');
    return fracP ? intP + '.' + fracP : intP;
  }

  function recommendedOu(opType) {
    var f = state.fees && state.fees[opType];
    if (!f) return null;
    var r = f.recommended || f.minimum;
    if (!r) return null;
    return String(r);
  }

  function explorerBaseFor(rpcUrl, fallback) {
    var rpc = String(rpcUrl || '');
    if (rpc.indexOf('devnet') >= 0 || rpc.indexOf('165.227.225.79') >= 0) return 'https://devnet.octrascan.io';
    if (rpc === 'https://octrascan.io/rpc' || rpc === 'http://46.101.86.250:8080') return 'https://octrascan.io';
    return fallback || 'https://octrascan.io';
  }

  function explorerTxRow(hash) {
    if (!hash) return kv('tx hash', '<span class="muted">(missing)</span>');
    var rpc = state.walletInfo && state.walletInfo.rpc_url;
    var fallback = state.walletInfo && state.walletInfo.explorer_url;
    var base = explorerBaseFor(rpc, fallback);
    var url = base.replace(/\/+$/, '') + '/tx.html?hash=' + encodeURIComponent(hash);
    return kv('tx hash',
      '<span class="mono">' + esc(hash) + '</span>'
      + ' <a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" style="font-size:10px;margin-left:6px">explorer ↗</a>'
    );
  }

  function feeRowHtml(ouStr) {
    if (!ouStr) return '';
    return kv('fee', esc(rawToOct(ouStr)) + ' oct <span class="muted">(' + esc(ouStr) + ' ou)</span>');
  }

  function octToRaw(humanStr) {
    var s = String(humanStr == null ? '' : humanStr).trim();
    if (!s) return null;
    if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(s)) return null;
    var parts = s.split('.');
    var intPart = parts[0] || '0';
    var fracPart = (parts[1] || '').padEnd(6, '0');
    var combined = (intPart + fracPart).replace(/^0+/, '') || '0';
    return combined;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function isValidOrigin(o) {
    if (!o || typeof o !== 'string') return false;
    if (o === 'null') return false;
    if (o.length > 512) return false;
    if (/[\x00-\x20\x7f]/.test(o)) return false;
    var u;
    try { u = new URL(o); } catch (e) { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!u.hostname) return false;
    if (u.username || u.password) return false;
    if (u.search || u.hash) return false;
    if (u.pathname && u.pathname !== '/' && u.pathname !== '') return false;
    if (u.origin !== o) return false;
    return true;
  }

  function isValidId(id) {
    return typeof id === 'string'
      && id.length > 0
      && id.length <= 128
      && !/[\x00-\x1f\x7f]/.test(id);
  }

  function extractDomain(origin) {
    try { return new URL(origin).host; } catch (e) { return origin; }
  }

  function isInsecureOrigin(origin) {
    if (!origin) return true;
    if (origin.indexOf('https://') === 0) return false;
    var host = extractDomain(origin);
    if (host === 'localhost' || host.indexOf('localhost:') === 0) return false;
    if (host === '127.0.0.1' || host.indexOf('127.0.0.1:') === 0) return false;
    return true;
  }

  function respond(payload) {
    if (state.responded) return;
    if (!window.opener || !state.openerOrigin) return;
    var msg = Object.assign({
      type: 'response',
      version: PROTOCOL_VERSION,
      id: state.request ? state.request.id : null,
      method: state.request ? state.request.method : null,
    }, payload);
    try {
      window.opener.postMessage(msg, state.openerOrigin);
      state.responded = true;
    } catch (e) {}
  }

  function closeWith(code, message) {
    respond({ ok: false, error: { code: code, message: message || code } });
    setTimeout(function() { try { window.close(); } catch (e) {} }, 80);
  }

  function respondOkAndClose(result) {
    respond({ ok: true, result: result || {} });
    setTimeout(function() { try { window.close(); } catch (e) {} }, 120);
  }

  function finishAndClose() {
    try { window.close(); } catch (e) {}
  }

  function sendReady() {
    if (!window.opener) return;
    try {
      window.opener.postMessage({ type: 'ready', version: PROTOCOL_VERSION, source: 'octra_wallet' }, '*');
    } catch (e) {}
  }

  function startReadyLoop() {
    setLoadingStatus('waiting for request from dapp...');
    sendReady();
    state.readyTimer = setInterval(function() {
      state.readyAttempts++;
      if (state.readyAttempts === 1 || state.readyAttempts % 8 === 0) {
        setLoadingStatus('waiting for request from dapp... (' + state.readyAttempts + ')');
      }
      if (state.request || state.readyAttempts > 120) {
        clearInterval(state.readyTimer);
        if (!state.request && !state.responded) {
          showView('view-error');
          $('error-msg').textContent = 'no request received from dapp';
        }
        return;
      }
      sendReady();
    }, 250);
  }

  window.addEventListener('message', function(e) {
    if (e.source !== window.opener) return;
    var data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'request') return;
    if (e.origin === 'null' || !isValidOrigin(e.origin)) {
      state.request = { id: data.id || null, method: data.method || null };
      showView('view-error');
      $('error-msg').textContent = 'dapp must be served over http:// or https://; file:// origins are blocked';
      setTimeout(function() { try { window.close(); } catch (err) {} }, 1500);
      return;
    }
    if (data.version !== PROTOCOL_VERSION) {
      state.openerOrigin = e.origin;
      state.request = { id: isValidId(data.id) ? data.id : null, method: data.method || null };
      respond({ ok: false, error: { code: 'unsupported_version', message: 'protocol version mismatch' } });
      return;
    }
    if (!isValidId(data.id)) {
      state.openerOrigin = e.origin;
      state.request = { id: null, method: data.method || null };
      respond({ ok: false, error: { code: 'invalid_request', message: 'request "id" must be a non-empty string up to 128 chars' } });
      return;
    }
    if (state.request) return;

    state.openerOrigin = e.origin;
    state.request = {
      id: data.id || null,
      method: data.method || '',
      params: data.params || {},
      dapp_name: data.dapp_name || '',
      dapp_url: data.dapp_url || '',
    };
    if (state.readyTimer) { clearInterval(state.readyTimer); state.readyTimer = null; }
    renderHeader();
    boot();
  });

  function renderHeader() {
    var badge = $('origin-badge');
    badge.textContent = state.openerOrigin || '';
    if (isInsecureOrigin(state.openerOrigin)) {
      badge.classList.add('insecure');
      badge.title = 'non-https origin — treat all requests with extra care';
    }
    var hdr = $('header-method');
    var m = state.request.method;
    hdr.textContent = methodLabel(m);
  }

  function methodLabel(m) {
    var map = {
      'connect': 'connect',
      'send': 'send oct',
      'contract_call': 'contract call',
      'stealth_send': 'stealth send',
      'encrypt': 'encrypt balance',
      'decrypt': 'decrypt balance',
      'fhe_encrypt': 'fhe encrypt',
      'fhe_decrypt': 'fhe decrypt',
      'switch_network': 'switch network',
    };
    return map[m] || (m || 'signature request');
  }

  async function boot() {
    setLoadingStatus('checking wallet status...');
    var st;
    try {
      st = await api('GET', '/api/wallet/status');
    } catch (e) {
      closeWith('internal_error', 'webcli unreachable: ' + e.message);
      showView('view-error');
      return;
    }
    if (!st.loaded) {
      if (st.needs_pin || st.has_legacy) {
        var wallets = Array.isArray(st.wallets) ? st.wallets : [];
        state.lockedWallets = wallets;
        var picker = $('wallet-picker');
        var pickerRow = $('wallet-picker-row');
        picker.innerHTML = '';
        for (var i = 0; i < wallets.length; i++) {
          var w = wallets[i];
          var opt = document.createElement('option');
          opt.value = String(i);
          var label = (w.name || 'wallet') + ' — ' + fmtAddr(w.addr || '');
          opt.textContent = label;
          picker.appendChild(opt);
        }
        pickerRow.style.display = wallets.length > 1 ? 'block' : 'none';
        showView('view-locked');
        setTimeout(function() { try { $('pin-input').focus(); } catch (e) {} }, 40);
        return;
      }
      respond({ ok: false, error: { code: 'no_wallet', message: 'no wallet configured in webcli' } });
      showView('view-no-wallet');
      return;
    }

    setLoadingStatus('loading wallet info...');
    try {
      state.walletInfo = await api('GET', '/api/wallet');
    } catch (e) {
      closeWith('internal_error', 'wallet info unavailable');
      return;
    }
    setLoadingStatus('loading balance...');
    try {
      state.balance = await api('GET', '/api/balance');
    } catch (e) {
      state.balance = {};
    }
    setLoadingStatus('loading fee schedule...');
    try {
      state.fees = await api('GET', '/api/fee');
    } catch (e) {
      state.fees = {};
    }

    // Strict authorization: every non-connect/disconnect method requires the
    // dapp's origin to already be in the connection list for this wallet.
    // Matches MetaMask (eth_requestAccounts) / Phantom (session token) gating.
    if (state.request.method !== 'connect' && state.request.method !== 'disconnect') {
      setLoadingStatus('checking connection...');
      var isConnected = false;
      try {
        var conns = await api('GET', '/api/dapp/connections');
        var list = (conns && conns.connections) || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].origin === state.openerOrigin) { isConnected = true; break; }
        }
      } catch (e) {}
      if (!isConnected) {
        respond({
          ok: false,
          error: {
            code: 'not_connected',
            message: 'this dapp is not connected to the active wallet — call connect() first',
          },
        });
        showView('view-error');
        $('error-msg').textContent = 'this dapp is not connected to the active wallet · call connect() first';
        return;
      }
    }

    var handler = METHOD_HANDLERS[state.request.method];
    if (!handler) {
      closeWith('unsupported_method', 'method not supported: ' + state.request.method);
      showView('view-error');
      $('error-msg').textContent = 'unsupported method: ' + state.request.method;
      return;
    }

    try {
      setLoadingStatus('rendering approval...');
      handler.renderApprove();
    } catch (e) {
      closeWith('invalid_params', e.message || 'invalid params');
      showView('view-error');
      $('error-msg').textContent = 'invalid params: ' + (e.message || e);
      return;
    }
    populateSigningAs();
    showView('view-approve');
  }

  function populateSigningAs() {
    $('my-addr').textContent = fmtAddr(state.walletInfo.address);
    $('my-addr').title = state.walletInfo.address || '';
    var bal = state.balance && state.balance.public_balance;
    $('my-balance').textContent = rawToOct(bal) + ' oct';
    $('my-network').textContent = extractDomain(state.walletInfo.rpc_url || '');
    $('my-network').title = state.walletInfo.rpc_url || '';
  }

  async function doUnlock() {
    var pin = $('pin-input').value.trim();
    var errEl = $('pin-err');
    errEl.style.display = 'none';
    if (pin.length !== 6 || !/^[0-9]+$/.test(pin)) {
      errEl.textContent = 'pin must be 6 digits';
      errEl.style.display = 'block';
      return;
    }
    var btnUnlock = $('btn-unlock');
    var btnCancel = $('btn-cancel-unlock');
    var picker = $('wallet-picker');
    var statusEl = $('unlock-status');
    btnUnlock.disabled = true;
    if (btnCancel) btnCancel.disabled = true;
    if (picker) picker.disabled = true;
    $('pin-input').disabled = true;
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.className = 'status-line info';
      statusEl.textContent = 'unlocking... (this can take several seconds)';
    }
    try {
      var unlockBody = { pin: pin };
      var wallets = state.lockedWallets || [];
      if (wallets.length > 0) {
        var idx = 0;
        if (picker) {
          var v = parseInt(picker.value, 10);
          if (!isNaN(v) && v >= 0 && v < wallets.length) idx = v;
        }
        var w = wallets[idx];
        if (w && w.addr) unlockBody.addr = w.addr;
        if (w && w.file) unlockBody.file = w.file;
      }
      await api('POST', '/api/wallet/unlock', unlockBody);
      if (statusEl) statusEl.textContent = 'loading wallet...';
      await boot();
    } catch (e) {
      btnUnlock.disabled = false;
      if (btnCancel) btnCancel.disabled = false;
      if (picker) picker.disabled = false;
      $('pin-input').disabled = false;
      if (statusEl) statusEl.style.display = 'none';
      errEl.textContent = e.message || 'wrong pin';
      errEl.style.display = 'block';
    }
  }

  async function doApprove() {
    var handler = METHOD_HANDLERS[state.request.method];
    if (!handler) return closeWith('unsupported_method', 'not supported');
    $('btn-approve').disabled = true;
    var status = $('submit-status');
    status.style.display = 'block';
    status.className = 'status-line info';
    status.textContent = 'submitting...';
    try {
      var result = await handler.execute();
      status.textContent = '';
      status.style.display = 'none';
      handler.renderResult(result);
      showView('view-result');
      respond({ ok: true, result: result });
    } catch (e) {
      status.className = 'status-line err';
      status.textContent = 'failed: ' + (e.message || e);
      $('btn-approve').disabled = false;
    }
  }

  function _isTableTarget() {
    var el = document.getElementById('method-details');
    return !!(el && el.tagName === 'TABLE');
  }

  function kv(label, valueHtml, opts) {
    var isAmount = opts && opts.amount;
    if (_isTableTarget()) {
      var tdCls = isAmount ? ' class="mono amount"' : ' class="mono"';
      return '<tr><td>' + esc(label) + '</td><td' + tdCls + '>' + valueHtml + '</td></tr>';
    }
    var spanCls = isAmount ? ' class="v amount"' : ' class="v"';
    return '<div class="kv-row"><span class="k">' + esc(label) + '</span><span' + spanCls + '>' + valueHtml + '</span></div>';
  }

  function setMethodDetails(label, rows) {
    if (_isTableTarget()) {
      var lab = document.getElementById('method-label');
      if (lab) lab.textContent = label;
      document.getElementById('method-details').innerHTML = rows;
    } else {
      var box = $('method-details');
      box.innerHTML = '<div class="sec-label">' + esc(label) + '</div>' + rows;
    }
  }

  function simpleResult(label, rows) {
    $('result-label').textContent = label;
    $('result-body').innerHTML = rows;
  }

  var METHOD_HANDLERS = {

    connect: {
      renderApprove: function() {
        $('approve-warn').textContent = 'this dapp wants to know your wallet address and public key.';
        setMethodDetails('connect request',
          kv('origin', esc(state.openerOrigin)) +
          (state.request.dapp_name ? kv('dapp (self-reported)', esc(state.request.dapp_name)) : '')
        );
      },
      execute: async function() {
        await api('POST', '/api/dapp/connect', { origin: state.openerOrigin });
        return {
          address: state.walletInfo.address,
          public_key: state.walletInfo.public_key,
          rpc_url: state.walletInfo.rpc_url,
        };
      },
      renderResult: function(r) {
        simpleResult('connected',
          kv('address', esc(fmtAddr(r.address))) +
          kv('network', esc(extractDomain(r.rpc_url)))
        );
      },
    },

    send: {
      renderApprove: function() {
        var p = state.request.params || {};
        if (!p.to || typeof p.to !== 'string') throw new Error('missing "to"');
        var rawStr = (p.amount_raw != null) ? String(p.amount_raw)
                   : octToRaw(p.amount);
        if (!rawStr) throw new Error('missing or invalid "amount"');
        state._sendRaw = rawStr;
        state._ou = recommendedOu('standard');
        $('approve-warn').textContent = 'transfer is irreversible. verify recipient carefully.';
        var rows =
          kv('to', esc(p.to)) +
          kv('amount', esc(rawToOct(rawStr)) + ' oct', { amount: true });
        if (p.message) rows += kv('message', esc(p.message));
        rows += feeRowHtml(state._ou);
        setMethodDetails('send oct', rows);
      },
      execute: async function() {
        var p = state.request.params;
        var body = {
          to: p.to,
          amount: rawToOct(state._sendRaw),
          message: p.message || '',
        };
        if (state._ou) body.ou = state._ou;
        return await api('POST', '/api/send', body);
      },
      renderResult: function(r) {
        simpleResult('submitted',
          explorerTxRow(r.tx_hash || r.hash || '')
        );
      },
    },

    contract_call: {
      renderApprove: function() {
        var p = state.request.params || {};
        if (!p.address) throw new Error('missing contract "address"');
        if (!p.method) throw new Error('missing "method"');
        var params = p.params || [];
        if (!Array.isArray(params)) throw new Error('"params" must be an array');
        var rawStr = '0';
        if (p.amount != null || p.amount_raw != null) {
          rawStr = (p.amount_raw != null) ? String(p.amount_raw) : octToRaw(p.amount);
          if (!rawStr) throw new Error('invalid "amount"');
        }
        state._callParams = params;
        state._callRaw = rawStr;
        var ouHint = (p.ou && /^[0-9]+$/.test(String(p.ou))) ? String(p.ou) : null;
        state._callOu = ouHint || recommendedOu('call') || '1000';
        $('approve-warn').textContent = 'contract calls may transfer funds or modify state. review carefully.';
        var rows =
          kv('contract', esc(p.address)) +
          kv('method', esc(p.method)) +
          kv('params', esc(JSON.stringify(params)));
        if (rawStr !== '0') rows += kv('amount', esc(rawToOct(rawStr)) + ' oct', { amount: true });
        rows += feeRowHtml(state._callOu);
        setMethodDetails('contract call', rows);
      },
      execute: async function() {
        var p = state.request.params;
        return await api('POST', '/api/contract/call', {
          address: p.address,
          method: p.method,
          params: state._callParams,
          amount: String(state._callRaw),
          ou: state._callOu,
        });
      },
      renderResult: function(r) {
        simpleResult('submitted',
          explorerTxRow(r.tx_hash || r.hash || '')
        );
      },
    },

    stealth_send: {
      renderApprove: function() {
        var p = state.request.params || {};
        if (!p.to) throw new Error('missing "to"');
        var rawStr = (p.amount_raw != null) ? String(p.amount_raw) : octToRaw(p.amount);
        if (!rawStr) throw new Error('missing or invalid "amount"');
        state._sendRaw = rawStr;
        state._ou = recommendedOu('stealth');
        $('approve-warn').textContent = 'stealth transfer: amount hidden on-chain. verify recipient.';
        var rows =
          kv('to', esc(p.to)) +
          kv('amount', esc(rawToOct(rawStr)) + ' oct', { amount: true }) +
          kv('mode', 'stealth (on-chain observer cannot see amount)');
        rows += feeRowHtml(state._ou);
        setMethodDetails('stealth send', rows);
      },
      execute: async function() {
        var p = state.request.params;
        var body = { to: p.to, amount: rawToOct(state._sendRaw) };
        if (state._ou) body.ou = state._ou;
        return await api('POST', '/api/stealth/send', body);
      },
      renderResult: function(r) {
        simpleResult('submitted',
          explorerTxRow(r.tx_hash || r.hash || '')
        );
      },
    },

    encrypt: {
      renderApprove: function() {
        var p = state.request.params || {};
        var rawStr = (p.amount_raw != null) ? String(p.amount_raw) : octToRaw(p.amount);
        if (!rawStr) throw new Error('missing or invalid "amount"');
        state._sendRaw = rawStr;
        state._ou = recommendedOu('encrypt');
        $('approve-warn').textContent = 'this moves public oct into your encrypted balance.';
        setMethodDetails('encrypt balance',
          kv('amount', esc(rawToOct(rawStr)) + ' oct', { amount: true }) +
          feeRowHtml(state._ou)
        );
      },
      execute: async function() {
        var body = { amount: rawToOct(state._sendRaw) };
        if (state._ou) body.ou = state._ou;
        return await api('POST', '/api/encrypt', body);
      },
      renderResult: function(r) {
        simpleResult('submitted',
          explorerTxRow(r.tx_hash || r.hash || '')
        );
      },
    },

    decrypt: {
      renderApprove: function() {
        var p = state.request.params || {};
        var rawStr = (p.amount_raw != null) ? String(p.amount_raw) : octToRaw(p.amount);
        if (!rawStr) throw new Error('missing or invalid "amount"');
        state._sendRaw = rawStr;
        state._ou = recommendedOu('decrypt');
        $('approve-warn').textContent = 'this moves encrypted oct back to your public balance.';
        setMethodDetails('decrypt balance',
          kv('amount', esc(rawToOct(rawStr)) + ' oct', { amount: true }) +
          feeRowHtml(state._ou)
        );
      },
      execute: async function() {
        var body = { amount: rawToOct(state._sendRaw) };
        if (state._ou) body.ou = state._ou;
        return await api('POST', '/api/decrypt', body);
      },
      renderResult: function(r) {
        simpleResult('submitted',
          explorerTxRow(r.tx_hash || r.hash || '')
        );
      },
    },

    fhe_encrypt: {
      renderApprove: function() {
        var p = state.request.params || {};
        if (p.value == null || !/^-?[0-9]+$/.test(String(p.value))) throw new Error('missing integer "value"');
        state._fheValue = String(p.value);
        $('approve-warn').textContent = 'encrypts an integer with your pvac public key. no tx is broadcast.';
        var rows = kv('value', esc(state._fheValue), { amount: true });
        if (p.reason) rows += kv('reason (from dapp)', esc(p.reason));
        setMethodDetails('fhe encrypt', rows);
      },
      execute: async function() {
        return await api('POST', '/api/fhe/encrypt', { value: parseInt(state._fheValue, 10) });
      },
      renderResult: function(r) {
        var ct = esc(r.ciphertext || '');
        simpleResult('encrypted',
          kv('ciphertext',
            '<textarea readonly rows="6" onclick="this.select()" '
            + 'style="width:100%;box-sizing:border-box;font-family:\'SF Mono\',Consolas,Menlo,monospace;'
            + 'font-size:11px;line-height:1.45;border:1px solid #C0C6D0;padding:6px;background:#fff;'
            + 'color:#000;resize:vertical;word-break:break-all;">' + ct + '</textarea>'
          )
        );
      },
    },

    fhe_decrypt: {
      renderApprove: function() {
        var p = state.request.params || {};
        if (!p.ciphertext || typeof p.ciphertext !== 'string') throw new Error('missing "ciphertext"');
        state._fheCipher = p.ciphertext;
        $('approve-warn').textContent = 'DECRYPTING reveals a value to the dapp. only approve if you understand what is being decrypted.';
        var rows = kv('ciphertext',
          '<textarea readonly rows="4" onclick="this.select()" '
          + 'style="width:100%;box-sizing:border-box;font-family:\'SF Mono\',Consolas,Menlo,monospace;'
          + 'font-size:11px;line-height:1.45;border:1px solid #C0C6D0;padding:6px;background:#fff;'
          + 'color:#000;resize:vertical;word-break:break-all;">' + esc(p.ciphertext) + '</textarea>'
        );
        if (p.reason) rows += kv('reason (from dapp)', esc(p.reason));
        setMethodDetails('fhe decrypt', rows);
      },
      execute: async function() {
        return await api('POST', '/api/fhe/decrypt', { ciphertext: state._fheCipher });
      },
      renderResult: function(r) {
        simpleResult('decrypted',
          kv('value', esc(r.value != null ? r.value : '(see dapp)'), { amount: true })
        );
      },
    },

    switch_network: {
      renderApprove: function() {
        var p = state.request.params || {};
        var allowed = {
          mainnet: 'http://46.101.86.250:8080',
          devnet: 'http://165.227.225.79:8080',
        };
        if (!p.network || !(p.network in allowed)) {
          throw new Error('unsupported network (must be mainnet or devnet)');
        }
        state._newRpc = allowed[p.network];
        state._newNet = p.network;
        $('approve-warn').textContent = 'this changes the active wallet\'s rpc endpoint. verify carefully.';
        setMethodDetails('switch network',
          kv('from', esc(state.walletInfo.rpc_url || '')) +
          kv('to', esc(p.network)) +
          kv('endpoint', esc(state._newRpc))
        );
      },
      execute: async function() {
        return await api('POST', '/api/settings', { rpc_url: state._newRpc });
      },
      renderResult: function(r) {
        simpleResult('switched',
          kv('network', esc(state._newNet)) +
          kv('rpc_url', esc(r.rpc_url || state._newRpc))
        );
      },
    },

  };

  // anti-clickjacking: refuse to render if framed
  if (window.top !== window.self) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#8B3A3A;font-family:Tahoma,sans-serif">embedding blocked</div>';
    return;
  }

  // Signal cancel if popup is closed before a response is sent
  window.addEventListener('beforeunload', function() {
    if (state.responded || !window.opener || !state.openerOrigin) return;
    try {
      window.opener.postMessage({
        type: 'response',
        version: PROTOCOL_VERSION,
        id: state.request ? state.request.id : null,
        method: state.request ? state.request.method : null,
        ok: false,
        error: { code: 'popup_closed', message: 'popup closed before approval' },
      }, state.openerOrigin);
    } catch (e) {}
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && $('view-locked').style.display === 'block') doUnlock();
  });

  // Public surface used by inline HTML onclicks
  window.signUi = {
    doApprove: doApprove,
    doUnlock: doUnlock,
    closeWith: closeWith,
    finishAndClose: finishAndClose,
  };

  if (!window.opener) {
    showView('view-error');
    $('error-msg').textContent = 'this page must be opened by a dapp via window.open';
    return;
  }
  startReadyLoop();

})();
