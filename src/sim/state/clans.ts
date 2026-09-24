/**
 * A clan stores ONLY: id, name, founding record, camp position, food store,
 * history (§0.2). Everything else (leader, territory, culture, relations) is
 * derived from individuals on demand.
 */

export interface ClanFounding {
  tick: number;
  parentClanId: number; // -1 for initial clans
  founderId: number; // -1 for initial clans
  eventId: number;
}

export interface Clan {
  id: number;
  name: string;
  founding: ClanFounding;
  campX: number;
  campY: number;
  foodStore: number;
  /** Event ids of macro events involving this clan. */
  history: number[];
  /** Tick of dissolution, or -1 while extant. Part of history, not a derived property. */
  dissolvedTick: number;
}

export class ClanRegistry {
  /** Monotonic, never reused (§7). */
  nextId = 1;
  clans = new Map<number, Clan>();

  create(name: string, campX: number, campY: number, founding: ClanFounding): Clan {
    const clan: Clan = {
      id: this.nextId++,
      name,
      founding,
      campX,
      campY,
      foodStore: 0,
      history: [],
      dissolvedTick: -1,
    };
    this.clans.set(clan.id, clan);
    return clan;
  }

  get(id: number): Clan | undefined {
    return this.clans.get(id);
  }

  /** Extant clans in ascending id order. */
  extant(): Clan[] {
    return [...this.clans.values()].filter((c) => c.dissolvedTick < 0).sort((a, b) => a.id - b.id);
  }

  label(id: number): string {
    const c = this.clans.get(id);
    return c ? `Clan ${c.id} · ${c.name}` : 'loner';
  }
}
