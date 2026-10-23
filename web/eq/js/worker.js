import * as C from './core.js';

onmessage = e => {
  const { id, meas, target, opt } = e.data;
  try {
    const an = C.analyse(meas, target, opt);
    const fit = C.fit(an, opt);
    fit.slots = fit.slots.map(({ fStep, ...rest }) => rest);
    postMessage({ id, an, fit });
  } catch (err) {
    postMessage({ id, error: err.message });
  }
};
