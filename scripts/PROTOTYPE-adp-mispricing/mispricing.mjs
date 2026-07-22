// PROTOTYPE — throwaway. The pure, portable half.
//
// THE QUESTION THIS ANSWERS
// ------------------------
// Does the national fantasy ADP market misprice players in a way that is
// (a) systematic, (b) explainable by covariates knowable in August, and
// (c) persistent enough to survive walk-forward validation?
//
// If yes, the value curve + residual model below lift into the real draft-board
// build as a "market edge" field. If no, the answer is "the market is efficient
// enough that ADP is your best prior" — which is also worth knowing, and is the
// null this is built to fail against.
//
// Everything here is pure: no fetch, no fs, no console. The shell (run.mjs) does I/O.

// ---------------------------------------------------------------- linear algebra

/** Solve Ax = b by Gaussian elimination with partial pivoting. Returns null if singular. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/**
 * OLS with an intercept prepended. X is rows of predictors (no intercept column).
 * Returns { beta, se, t, r2, n } — beta[0] is the intercept.
 */
export function ols(X, y) {
  const n = y.length;
  const k = X[0].length + 1;
  const D = X.map((r) => [1, ...r]);
  const XtX = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => D.reduce((s, r) => s + r[i] * r[j], 0))
  );
  const Xty = Array.from({ length: k }, (_, i) => D.reduce((s, r, ri) => s + r[i] * y[ri], 0));
  const beta = solve(XtX, Xty);
  if (!beta) return null;
  const fitted = D.map((r) => r.reduce((s, v, i) => s + v * beta[i], 0));
  const resid = y.map((v, i) => v - fitted[i]);
  const rss = resid.reduce((s, e) => s + e * e, 0);
  const ybar = mean(y);
  const tss = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
  const sigma2 = rss / (n - k);
  // se = sqrt(diag(sigma2 * (X'X)^-1)); invert by solving against unit vectors
  const se = [];
  for (let i = 0; i < k; i++) {
    const e = new Array(k).fill(0);
    e[i] = 1;
    const col = solve(XtX, e);
    se.push(col ? Math.sqrt(Math.max(0, sigma2 * col[i])) : NaN);
  }
  return { beta, se, t: beta.map((b, i) => b / se[i]), r2: 1 - rss / tss, n, fitted, resid };
}

// ---------------------------------------------------------------- the value curve

/**
 * LOESS (local linear, tricube weights) — the market's implied value curve.
 * Fits on a grid and interpolates, so predict() is cheap.
 */
export function loess(xs, ys, { span = 0.45, grid = 120 } = {}) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  pts.sort((a, b) => a[0] - b[0]);
  const X = pts.map((p) => p[0]);
  const Y = pts.map((p) => p[1]);
  const n = X.length;
  const k = Math.max(4, Math.floor(span * n));
  const lo = X[0];
  const hi = X[n - 1];
  const gx = Array.from({ length: grid }, (_, i) => lo + ((hi - lo) * i) / (grid - 1));
  const gy = gx.map((x0) => {
    const d = X.map((x) => Math.abs(x - x0));
    const cut = [...d].sort((a, b) => a - b)[Math.min(k, n - 1)] || 1e-9;
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (let i = 0; i < n; i++) {
      const u = d[i] / cut;
      if (u >= 1) continue;
      const w = (1 - u ** 3) ** 3;
      sw += w; swx += w * X[i]; swy += w * Y[i];
      swxx += w * X[i] * X[i]; swxy += w * X[i] * Y[i];
    }
    const det = sw * swxx - swx * swx;
    if (Math.abs(det) < 1e-12) return sw ? swy / sw : 0;
    const b = (sw * swxy - swx * swy) / det;
    const a = (swy - b * swx) / sw;
    return a + b * x0;
  });
  return (x) => {
    if (x <= gx[0]) return gy[0];
    if (x >= gx[grid - 1]) return gy[grid - 1];
    const i = Math.min(grid - 2, Math.floor(((x - lo) / (hi - lo)) * (grid - 1)));
    const t = (x - gx[i]) / (gx[i + 1] - gx[i]);
    return gy[i] * (1 - t) + gy[i + 1] * t;
  };
}

/**
 * Fit one value curve per position over log(ADP), then attach residuals to every row.
 * `yKey` picks the payoff being explained (pointsIdx | gp | ppgIdx), so the same
 * machinery answers "was the market wrong?" and "wrong about WHAT?".
 */
export function fitCurves(rows, yKey, { span = 0.45 } = {}) {
  const curves = {};
  for (const pos of [...new Set(rows.map((r) => r.pos))]) {
    const sub = rows.filter((r) => r.pos === pos && Number.isFinite(r[yKey]));
    if (sub.length < 20) continue;
    curves[pos] = loess(sub.map((r) => Math.log(r.adp)), sub.map((r) => r[yKey]), { span });
  }
  return curves;
}

export function attachResiduals(rows, curves, yKey, outKey) {
  for (const r of rows) {
    const f = curves[r.pos];
    r[outKey] = f && Number.isFinite(r[yKey]) ? r[yKey] - f(Math.log(r.adp)) : null;
  }
  return rows;
}

// ---------------------------------------------------------------- stats helpers

export const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
export const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};

export function pearson(a, b) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

const ranks = (a) => {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let m = i; m <= j; m++) r[idx[m][1]] = avg;
    i = j + 1;
  }
  return r;
};

export const spearman = (a, b) => pearson(ranks(a), ranks(b));

/** Split predictions into terciles and report the actual mean outcome in each. */
export function tercileSpread(pred, actual) {
  const order = pred.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const n = order.length;
  const cut = Math.floor(n / 3);
  const grab = (ids) => mean(ids.map((i) => actual[i]));
  return {
    bottom: grab(order.slice(0, cut)),
    middle: grab(order.slice(cut, n - cut)),
    top: grab(order.slice(n - cut)),
    n,
  };
}
