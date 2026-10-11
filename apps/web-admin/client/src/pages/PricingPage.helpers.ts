import { Decimal } from "decimal.js";

export const marginDisplay = (value: string | null) => value === null ? "—" : `${new Decimal(value).toDecimalPlaces(2).toString()}%`;
