export default {
  routes: [{ method: 'POST', path: '/customer/dispatch', handler: 'customer.dispatch', config: { auth: false } }],
};
