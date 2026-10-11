/**
 * A fresh in-memory database with the repository and leaderboard queries the
 * app needs, both over the same data, so tests see what they write.
 */
import { openDatabase } from '../../src/database.ts';
import { createDonationRepository } from '../../src/donations/donation-repository.ts';
import { createLeaderboardQueries } from '../../src/donations/leaderboard.ts';
import { createConnectionStore } from '../../src/platforms/connection-store.ts';

export function createInMemoryStore(now?: () => Date) {
  const database = openDatabase(':memory:');
  return {
    database,
    donations: createDonationRepository(database, now),
    leaderboard: createLeaderboardQueries(database),
    connections: createConnectionStore(database, now),
  };
}
