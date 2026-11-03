import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { Activity, Armchair, Building2, ChartColumn, ChartGantt, LayoutGrid, List, Network, Orbit, type LucideIcon } from 'lucide-react';
import type { ViewId } from '../types';

export interface ViewDef {
  id: ViewId;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** 3D views render a full-bleed canvas; the drawer floats over them */
  immersive: boolean;
  Component: LazyExoticComponent<ComponentType>;
}

export const VIEWS: ViewDef[] = [
  { id: 'office', label: 'Office', hint: 'A 3D office: each session works at a desk, sub-agents join as teammates', icon: Armchair, immersive: true, Component: lazy(() => import('./office/OfficeView')) },
  { id: 'command', label: 'Command', hint: 'Mission control: every live session with its feed and controls', icon: LayoutGrid, immersive: false, Component: lazy(() => import('./command/CommandView')) },
  { id: 'city', label: 'City', hint: 'Projects as towers that light up as Claude works', icon: Building2, immersive: true, Component: lazy(() => import('./city/CityView')) },
  { id: 'galaxy', label: 'Galaxy', hint: 'Projects as stars, sessions as planets, tool calls as comets', icon: Orbit, immersive: true, Component: lazy(() => import('./galaxy/GalaxyView')) },
  { id: 'timeline', label: 'Timeline', hint: 'Every tool call on one time axis, session by session', icon: ChartGantt, immersive: false, Component: lazy(() => import('./timeline/TimelineView')) },
  { id: 'graph', label: 'Graph', hint: 'Sessions, agents and the files they read and change', icon: Network, immersive: false, Component: lazy(() => import('./graph/GraphView')) },
  { id: 'stream', label: 'Stream', hint: 'One live feed of everything happening, filterable', icon: Activity, immersive: false, Component: lazy(() => import('./stream/StreamView')) },
  { id: 'analytics', label: 'Analytics', hint: 'Tokens, cost, tools and errors over time', icon: ChartColumn, immersive: false, Component: lazy(() => import('./analytics/AnalyticsView')) },
  { id: 'classic', label: 'Table', hint: 'Every session in one sortable table with quick actions', icon: List, immersive: false, Component: lazy(() => import('./classic/ClassicView')) },
];

export const viewById = (id: ViewId) => VIEWS.find((v) => v.id === id) ?? VIEWS[0];
