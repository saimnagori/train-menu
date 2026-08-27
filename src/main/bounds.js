const EDGE_PADDING = 8;

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

// Centre the window under the tray icon, clamped inside the work area: prefer
// below the icon, flip above if the window would not fit (a display whose menu
// bar is not at the top).
export function popoverBounds(trayBounds, workArea, size) {
  const trayCenterX = trayBounds.x + trayBounds.width / 2;
  const minX = workArea.x + EDGE_PADDING;
  const maxX = workArea.x + workArea.width - size.width - EDGE_PADDING;
  const x = Math.round(clamp(trayCenterX - size.width / 2, minX, maxX));

  const belowY = trayBounds.y + trayBounds.height + EDGE_PADDING;
  const aboveY = trayBounds.y - size.height - EDGE_PADDING;
  const fitsBelow = belowY + size.height <= workArea.y + workArea.height;
  const y = Math.round(
    fitsBelow
      ? belowY
      : clamp(aboveY, workArea.y + EDGE_PADDING, workArea.y + workArea.height - size.height - EDGE_PADDING),
  );

  return { x, y, width: size.width, height: size.height };
}
