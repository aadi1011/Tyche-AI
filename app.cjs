import('./server.mjs').catch(error => {
  console.error('tyche.ai failed to start:', error.code || error.message);
  process.exitCode = 1;
});