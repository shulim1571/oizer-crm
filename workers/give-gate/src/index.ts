import { handle, type GateEnv } from './gate';

export default {
  fetch: (req: Request, env: GateEnv) => handle(req, env),
};
