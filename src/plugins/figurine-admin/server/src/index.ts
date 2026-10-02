import routes from './routes';
import controllers from './controllers/figurines';
export default () => ({
  register() {},
  bootstrap() {},
  destroy() {},
  routes: { admin: { type: 'admin' as const, routes } },
  controllers: { figurines: controllers },
});
