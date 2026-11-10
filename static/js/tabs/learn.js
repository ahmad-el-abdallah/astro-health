// Learn tab: simple step-by-step guides (docs/build-prompt.md section 9.7).
const LearnTab = (() => {
  function init() {
    document.getElementById("tab-learn").innerHTML = `<h2>Learn</h2><div id="learn-content">Loading&hellip;</div>`;
  }

  async function onShow() {
    const content = await api("/content");
    const el = document.getElementById("learn-content");
    const cardsHtml = content.learn_cards.map((c) => `
      <div class="card"><h3>${c.title}</h3><p>${c.body}</p></div>`).join("");
    const hazardsHtml = Object.values(content.hazards).map((h) => `
      <div class="card"><h3>${h.label}</h3><p>${h.summary}</p></div>`).join("");
    const bodyPartsHtml = Object.values(content.body_parts).map((b) => `
      <div class="card"><h3>${b.label}</h3>
        <p>${b.what_it_does}</p>
        <p class="dim"><strong>In space:</strong> ${b.space_effects}</p>
        <p class="dim"><strong>What to do:</strong> ${b.what_to_do}</p>
      </div>`).join("");
    el.innerHTML = `
      <h3>The basics</h3><div class="card-grid">${cardsHtml}</div>
      <h3>The five hazards of spaceflight</h3><div class="card-grid">${hazardsHtml}</div>
      <h3>Body systems</h3><div class="card-grid">${bodyPartsHtml}</div>`;
  }

  return { init, onShow };
})();
registerTab("learn", LearnTab);
