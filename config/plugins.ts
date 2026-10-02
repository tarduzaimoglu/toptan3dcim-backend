export default () => ({
  'figurine-admin': { enabled: true, resolve: './src/plugins/figurine-admin' },
  'users-permissions': {
    config: {
      jwtManagement: process.env.CUSTOMER_ACCOUNTS_ENABLED === 'true' ? 'refresh' : 'legacy-support',
      sessions: {
        accessTokenLifespan: 600,
        maxRefreshTokenLifespan: 604800,
        idleRefreshTokenLifespan: 86400,
        maxSessionLifespan: 604800,
        idleSessionLifespan: 86400,
        httpOnly: true,
      },
    },
  },
  upload: {
    config: {
      provider: 'local',
      providerOptions: {},
      actionOptions: {
        upload: {},
        uploadStream: {},
        delete: {},
      },
    },
  },
});
