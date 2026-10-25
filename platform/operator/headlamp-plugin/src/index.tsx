import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { PlatformInstanceDetail } from './components/Detail';
import { PlatformInstanceList } from './components/List';
import { DETAILS_PATH, LIST_PATH, ROUTE_DETAILS, ROUTE_LIST } from './resource';

const SIDEBAR = 'platform-instances';

registerSidebarEntry({
  parent: null,
  name: SIDEBAR,
  label: 'Platform Instances',
  url: LIST_PATH,
  icon: 'mdi:cube-outline',
});

registerRoute({
  path: LIST_PATH,
  sidebar: SIDEBAR,
  name: ROUTE_LIST,
  exact: true,
  component: () => <PlatformInstanceList />,
});

registerRoute({
  path: DETAILS_PATH,
  sidebar: SIDEBAR,
  name: ROUTE_DETAILS,
  exact: true,
  component: () => <PlatformInstanceDetail />,
});
