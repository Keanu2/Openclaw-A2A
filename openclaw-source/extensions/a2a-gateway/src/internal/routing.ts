/**
 * A2A Gateway — Message Routing
 *
 * OpenClaw gateway-internal module — NOT part of the A2A spec.
 */

import type { A2ADestination, RouteResult, RoutingRule } from "./types-internal.js";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class Router {
  private rules: RoutingRule[];
  private defaultAgentId: string | undefined;

  constructor(rules: RoutingRule[], defaultAgentId?: string) {
    this.rules = [...rules];
    this.defaultAgentId = defaultAgentId;
  }

  /**
   * Determine which agent should handle a message based on its destination.
   *
   * Resolution order:
   *  1. Explicit agent_id on the destination
   *  2. Route key matched against configured rules
   *  3. Default agent (if configured)
   *  4. null (no route found)
   */
  route(destination: A2ADestination): RouteResult | null {
    // 1. Direct agent_id
    if (destination.agent_id) {
      return { agentId: destination.agent_id, matched_by: "agent_id" };
    }

    // 2. Route key lookup
    if (destination.route_key) {
      const rule = this.rules.find((r) => r.routeKey === destination.route_key);
      if (rule) {
        return { agentId: rule.agentId, matched_by: "route_key" };
      }
    }

    // 3. Default
    if (this.defaultAgentId) {
      return { agentId: this.defaultAgentId, matched_by: "default" };
    }

    // 4. No route
    return null;
  }

  /** Add a routing rule. */
  addRule(rule: RoutingRule): void {
    this.rules.push(rule);
  }

  /** Remove a routing rule by its route key. */
  removeRule(routeKey: string): void {
    this.rules = this.rules.filter((r) => r.routeKey !== routeKey);
  }

  /** Return all current routing rules. */
  getRules(): RoutingRule[] {
    return [...this.rules];
  }
}
