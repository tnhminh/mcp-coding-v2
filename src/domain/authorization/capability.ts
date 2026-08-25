import { z } from 'zod';

export const capabilitySchema = z.enum([
  'filesystem.read',
  'filesystem.write',
  'command.run',
  'git.read',
  'git.write',
]);

export type Capability = z.infer<typeof capabilitySchema>;
export const allCapabilities: readonly Capability[] = capabilitySchema.options;
