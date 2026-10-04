export interface PanelAnimationSettings {
  readonly shouldRenderRichAnimation: boolean;
  readonly prefersReducedMotion: boolean;
}

export interface PanelWindowPresentation<TBounds> {
  setBounds(bounds: TBounds, animate?: boolean): void;
  setOpacity(opacity: number): void;
}

export function shouldAnimatePanel(
  opening: boolean,
  benchmarkMode: boolean,
  readSettings: () => PanelAnimationSettings,
): boolean {
  if (!opening || benchmarkMode) return false;
  try {
    const settings = readSettings();
    return settings.shouldRenderRichAnimation && !settings.prefersReducedMotion;
  } catch {
    return false;
  }
}

export function setPanelInitialPresentation<TBounds>(
  window: PanelWindowPresentation<TBounds>,
  finalBounds: TBounds,
  animate: boolean,
): void {
  window.setBounds(finalBounds, false);
  window.setOpacity(animate ? 0 : 1);
}
