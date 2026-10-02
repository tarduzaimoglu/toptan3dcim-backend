import { Images } from '@strapi/icons';
import type { StrapiApp } from '@strapi/admin/strapi-admin';
export default {
  register(app: StrapiApp) {
    app.addMenuLink({
      to: '/plugins/figurine-admin', icon: Images,
      intlLabel: { id: 'figurine-admin.menu', defaultMessage: 'Kişiye Özel Figür Talepleri' },
      Component: () => import('./pages/Requests'), permissions: [], position: 7,
    });
    app.registerPlugin({ id: 'figurine-admin', name: 'Figurine requests' });
  },
};
