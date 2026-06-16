import { createRouter, createHashHistory } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

const hashHistory = createHashHistory();

export const router = createRouter({
  routeTree,
  history: hashHistory,
});
