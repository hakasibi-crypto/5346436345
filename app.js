(function () {
  var btn = document.getElementById('btn');
  var codeEl = document.getElementById('code');
  var statusEl = document.getElementById('status');

  var q = new URLSearchParams(location.search).get('code');
  if (q) codeEl.value = q.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ''; }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  btn.addEventListener('click', function () {
    var code = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) { setStatus('코드 6자리를 입력해 주세요.', 'err'); return; }
    if (!('geolocation' in navigator)) { setStatus('이 브라우저는 위치 기능을 지원하지 않아요.', 'err'); return; }
    if (!window.isSecureContext) { setStatus('위치 기능은 HTTPS 주소에서만 동작해요.', 'err'); return; }

    btn.disabled = true;
    setStatus('위치를 확인하는 중...');

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        post('/api/link/location', {
          code: code,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }).then(function (r) {
          if (r.ok) {
            setStatus('✅ 위치를 받았어요. 이제 게임으로 돌아가세요.', 'ok');
            btn.textContent = '완료';
          } else if (r.status === 404) {
            setStatus('코드가 올바르지 않거나 만료됐어요. 게임에서 다시 활성화해 주세요.', 'err');
            btn.disabled = false;
          } else if (r.status === 429) {
            setStatus('요청이 너무 많아요. 잠시 후 다시 시도해 주세요.', 'err');
            btn.disabled = false;
          } else {
            setStatus('전송에 실패했어요. 다시 시도해 주세요.', 'err');
            btn.disabled = false;
          }
        }).catch(function () {
          setStatus('서버에 연결할 수 없어요. 다시 시도해 주세요.', 'err');
          btn.disabled = false;
        });
      },
      function (err) {
        var denied = err.code === 1;
        post('/api/link/error', { code: code, reason: denied ? 'location_denied' : 'location_unavailable' }).catch(function () {});
        setStatus(denied
          ? '위치 권한이 거부됐어요. 브라우저 사이트 설정에서 허용한 뒤 다시 시도해 주세요.'
          : '위치를 가져올 수 없어요. GPS/네트워크 상태를 확인해 주세요.', 'err');
        btn.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
})();
