export default {
  routes: [
    { method: 'PUT', path: '/figurine/private-upload/:id', handler: 'figurine-local.put', config: { auth: false } },
    { method: 'GET', path: '/customer/figurine-photo/:id/:assetKey', handler: 'figurine-local.photo', config: { auth: false } },
  ],
};
