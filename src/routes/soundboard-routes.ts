/**
 * Public soundboard routes, registered only when soundboard.json exists.
 *
 *   GET /sounds/:id/audio    a sound's file, so viewers can preview it
 *
 * Sounds are looked up by id in the validated list, never by file name, so
 * only files the streamer listed are reachable.
 */
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';
import type { Sound } from '../soundboard/soundboard.ts';

export type SoundboardRouteDependencies = {
  readonly config: Config & { readonly soundboard: readonly Sound[] };
};

export function registerSoundboardRoutes(app: FastifyInstance, dependencies: SoundboardRouteDependencies): void {
  const { config } = dependencies;
  const soundsById = new Map(config.soundboard.map((sound) => [sound.id, sound]));

  app.get<{ Params: { id: string } }>('/sounds/:id/audio', async (request, reply) => {
    const sound = soundsById.get(request.params.id);
    if (sound === undefined) return reply.callNotFound();
    return reply.sendFile(sound.fileName, config.alert.assetsDirectory);
  });
}
