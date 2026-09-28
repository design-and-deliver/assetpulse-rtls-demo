import type { WorkOrder } from '@assetpulse/protocol';

/** The request a real integration would send to the ServiceNow Table API. */
export interface WmOrderRequest {
  method: 'POST' | 'PATCH';
  path: string;
  body: Omit<WorkOrder, 'opened_at'> & { opened_at: string; u_hospital_id: string };
}

/** ServiceNow's glide date-time format: `yyyy-MM-dd HH:mm:ss`, UTC. */
function glideDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** A newly opened order is created; any later state change updates the record by `number`. */
export function toWmOrderRequest(hospitalId: string, order: WorkOrder): WmOrderRequest {
  const body = { ...order, opened_at: glideDateTime(order.opened_at), u_hospital_id: hospitalId };
  return order.state === 'open'
    ? { method: 'POST', path: '/api/now/table/wm_order', body }
    : { method: 'PATCH', path: `/api/now/table/wm_order?number=${order.number}`, body };
}

/**
 * Stand-in for the ServiceNow adapter. It shapes the `wm_order` request and logs it; it never
 * touches the network (Decisions: no live ServiceNow calls).
 */
export class ServiceNowMock {
  constructor(private readonly log: (line: string) => void = console.log) {}

  submit(hospitalId: string, order: WorkOrder): WmOrderRequest {
    const request = toWmOrderRequest(hospitalId, order);
    this.log(`[servicenow-mock] ${request.method} ${request.path} ${JSON.stringify(request.body)}`);
    return request;
  }
}
