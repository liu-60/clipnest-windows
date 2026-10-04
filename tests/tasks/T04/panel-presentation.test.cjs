const assert = require("node:assert/strict");
const test = require("node:test");
const {
  setPanelInitialPresentation,
  shouldAnimatePanel,
} = require("../../../dist-electron/main/clipboard/panel-presentation.js");

function fakeWindow() {
  return {
    bounds: [],
    opacities: [],
    setBounds(bounds, animate) { this.bounds.push({ bounds, animate }); },
    setOpacity(opacity) { this.opacities.push(opacity); },
  };
}

test("opening applies final bounds once and reduced motion skips the fade", () => {
  const finalBounds = { x: 0, y: 700, width: 1200, height: 400 };
  const window = fakeWindow();
  const animate = shouldAnimatePanel(true, false, () => ({
    shouldRenderRichAnimation: true,
    prefersReducedMotion: true,
  }));

  setPanelInitialPresentation(window, finalBounds, animate);

  assert.equal(animate, false);
  assert.deepEqual(window.bounds, [{ bounds: finalBounds, animate: false }]);
  assert.deepEqual(window.opacities, [1]);
});

test("opening fades only when rich animation is available and reduced motion is off", () => {
  const window = fakeWindow();
  const animate = shouldAnimatePanel(true, false, () => ({
    shouldRenderRichAnimation: true,
    prefersReducedMotion: false,
  }));

  setPanelInitialPresentation(window, { x: 10, y: 20, width: 800, height: 400 }, animate);

  assert.equal(animate, true);
  assert.equal(window.bounds.length, 1);
  assert.deepEqual(window.opacities, [0]);
});

test("repeated renders, benchmark mode, and unavailable system settings fail closed", () => {
  let settingsReads = 0;
  const readSettings = () => {
    settingsReads += 1;
    return { shouldRenderRichAnimation: true, prefersReducedMotion: false };
  };

  assert.equal(shouldAnimatePanel(false, false, readSettings), false);
  assert.equal(shouldAnimatePanel(true, true, readSettings), false);
  assert.equal(settingsReads, 0);
  assert.equal(shouldAnimatePanel(true, false, () => { throw new Error("unavailable"); }), false);
});
