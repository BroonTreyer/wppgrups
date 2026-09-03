(() => {
  const send = (payload) => {
    if (typeof payload !== "string" || payload.length > 200000) return;
    if (!payload.includes("meli.la/") && !payload.includes("/sec/") && !payload.includes("ref=")) return;
    window.postMessage({ source: "ofertaflow-hook", payload }, "*");
  };

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    response.clone().text().then(send).catch(() => {});
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(...args) {
    this.addEventListener("load", () => {
      try { send(String(this.responseText)); } catch {}
    });
    return originalOpen.apply(this, args);
  };
})();
