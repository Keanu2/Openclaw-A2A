export {
  MessageType,
  filterHeaders,
  HOP_BY_HOP_HEADERS,
  type TunnelHttpRequest,
  type TunnelHttpResponse,
  type TunnelSessionOptions,
  type TunnelLogger,
} from "./protocol.js";

export { TunnelSession, createTunnelSession } from "./session.js";
export { createTunnelFetch } from "./tunnel-fetch.js";
