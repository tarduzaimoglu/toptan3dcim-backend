export default (plugin: any) => {
  // Strapi's `unique` validation alone does not create an SQL UNIQUE constraint.
  // This database column constraint survives Strapi schema synchronization.
  if (process.env.CUSTOMER_ACCOUNTS_ENABLED === 'true') {
    const field = plugin.contentTypes.user.schema.attributes.email;
    field.column = { ...(field.column || {}), unique: true };
  }
  return plugin;
};
