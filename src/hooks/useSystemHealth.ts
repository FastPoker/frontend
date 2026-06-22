'use client';

import { useEffect, useState } from 'react';
import {
  getSystemHealth,
  subscribeSystemHealth,
  type SystemHealthSnapshot,
} from '@/lib/system-health';

/** Subscribes to the module-level system-health bus. */
export function useSystemHealth(): SystemHealthSnapshot {
  const [state, setState] = useState<SystemHealthSnapshot>(getSystemHealth());
  useEffect(() => {
    setState(getSystemHealth());
    return subscribeSystemHealth(setState);
  }, []);
  return state;
}
