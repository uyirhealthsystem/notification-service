// What /health reports. Only "running" (joined the consumer group and fetching)
// is healthy: an HTTP server that is up while nothing is being consumed would
// otherwise look fine to Docker / the load balancer / an uptime check.
export type ConsumerState = "starting" | "running" | "restarting" | "stopped";

let state: ConsumerState = "starting";

export const getConsumerState = (): ConsumerState => state;
export const setConsumerState = (next: ConsumerState): void => {
  state = next;
};
