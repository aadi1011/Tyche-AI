import('./server.mjs').then(({ createSiteServer }) => {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = createSiteServer();
  server.on('error', error => {
    console.error('tyche.ai failed to listen:', error.code || error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`tyche.ai listening on ${typeof address === 'string' ? address : `${address.address}:${address.port}`}`);
  });
}).catch(error => {
  console.error('tyche.ai failed to start:', error.code || error.message);
  process.exitCode = 1;
});