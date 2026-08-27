// The mark: two rails and their ties running away into the tunnel.
//
// Drawn in a 22-unit square - the menu bar's own height, so a unit is a point at
// 1x - and left to the caller to place: set a transform, then call. Both icon
// scripts inject this function into their canvas page as source text, which is
// how one set of numbers ends up drawing the 22px stencil and the 1024px Finder
// tile without either script owning the geometry.
export function drawTrack(ctx, ink) {
  const bottom = 16.8;
  const top = 4.8;
  const lb = 1.2; // rails at the near end, wide apart
  const rb = 14.8;
  const lt = 6.7; // and at the far end, nearly met
  const rt = 9.3;

  ctx.lineCap = "butt";
  // Ties first, so the rails sit on top of them the way they do on the ground.
  // Their spacing and their weight both compress with distance; that is the
  // whole illusion, and it is what stops this reading as a flat triangle.
  for (const t of [0.04, 0.32, 0.62, 0.88]) {
    const y = bottom + (top - bottom) * t;
    const x0 = lb + (lt - lb) * t;
    const x1 = rb + (rt - rb) * t;
    ctx.strokeStyle = ink(0.85 - t * 0.55);
    ctx.lineWidth = 1.5 - t * 0.5;
    ctx.beginPath();
    ctx.moveTo(x0 - 0.9, y);
    ctx.lineTo(x1 + 0.9, y);
    ctx.stroke();
  }

  ctx.strokeStyle = ink(0.95);
  ctx.lineWidth = 1.7;
  for (const [xb, xt] of [
    [lb, lt],
    [rb, rt],
  ]) {
    ctx.beginPath();
    ctx.moveTo(xb, bottom);
    ctx.lineTo(xt, top);
    ctx.stroke();
  }
}

export const TRACK_SOURCE = drawTrack.toString();
