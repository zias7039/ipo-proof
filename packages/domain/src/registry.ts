import type { Fund, FundId, IPO, IpoId } from "./model.js";

/** Independent registry of funds and their underlying-fund structure. */
export interface FundRegistry {
  getFund(fundId: FundId): Fund | undefined;
}

export interface IpoRegistry {
  getIpo(ipoId: IpoId): IPO | undefined;
}

export class InMemoryFundRegistry implements FundRegistry {
  private readonly funds: ReadonlyMap<FundId, Fund>;
  constructor(funds: Iterable<Fund>) {
    this.funds = new Map([...funds].map((f) => [f.fundId, f]));
  }
  getFund(fundId: FundId): Fund | undefined {
    return this.funds.get(fundId);
  }
}

export class InMemoryIpoRegistry implements IpoRegistry {
  private readonly ipos: ReadonlyMap<IpoId, IPO>;
  constructor(ipos: Iterable<IPO>) {
    this.ipos = new Map([...ipos].map((i) => [i.ipoId, i]));
  }
  getIpo(ipoId: IpoId): IPO | undefined {
    return this.ipos.get(ipoId);
  }
}
