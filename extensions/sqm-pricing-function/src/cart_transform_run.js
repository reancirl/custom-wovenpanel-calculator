// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").FunctionRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

const DEFAULT_MIN_LENGTH = 0.1;
const DEFAULT_MAX_LENGTH = 100;
const DEFAULT_MIN_WIDTH = 0.1;
const DEFAULT_MAX_WIDTH = 100;
const AREA_TOLERANCE = 0.01;

/**
 * @param {string | null | undefined} value
 */
function parseDecimal(value) {
  if (typeof value !== "string") return null;
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;

  const parsedValue = Number.parseFloat(trimmedValue);
  if (!Number.isFinite(parsedValue)) return null;

  return parsedValue;
}

/**
 * @param {string | null | undefined} value
 */
function parsePositiveDecimal(value) {
  const parsedValue = parseDecimal(value);
  if (parsedValue === null || parsedValue <= 0) return null;

  return parsedValue;
}

/**
 * @param {string | null | undefined} value
 */
function parseBoolean(value) {
  return value === "true";
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function isWithinRange(value, min, max) {
  return value >= min && value <= max;
}

/**
 * @param {number} first
 * @param {number} second
 */
function areClose(first, second) {
  return Math.abs(first - second) <= AREA_TOLERANCE;
}

/**
 * @param {number} amount
 */
function toMoneyString(amount) {
  return (Math.round(amount * 100) / 100).toFixed(2);
}

/**
 * @param {string} key
 * @param {string | null | undefined} value
 */
function buildAttribute(key, value) {
  if (typeof value !== "string") return null;
  return { key, value };
}

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  if (!input.cart?.lines?.length) {
    return NO_CHANGES;
  }

  const operations = [];

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    const product = line.merchandise.product;
    const enableSqmPricing = parseBoolean(product.enableSqmPricing?.value);
    if (!enableSqmPricing) continue;

    const length = parsePositiveDecimal(line.length?.value);
    const width = parsePositiveDecimal(line.width?.value);
    if (length === null || width === null) continue;

    const baseUnitPrice = parsePositiveDecimal(line.cost?.amountPerQuantity?.amount);
    if (baseUnitPrice === null) continue;

    const minLength = parsePositiveDecimal(product.minLength?.value) ?? DEFAULT_MIN_LENGTH;
    const maxLength = parsePositiveDecimal(product.maxLength?.value) ?? DEFAULT_MAX_LENGTH;
    const minWidth = parsePositiveDecimal(product.minWidth?.value) ?? DEFAULT_MIN_WIDTH;
    const maxWidth = parsePositiveDecimal(product.maxWidth?.value) ?? DEFAULT_MAX_WIDTH;

    if (
      !isWithinRange(length, minLength, maxLength) ||
      !isWithinRange(width, minWidth, maxWidth)
    ) {
      continue;
    }

    const calculatedArea = length * width;
    const providedArea = parsePositiveDecimal(line.area?.value);
    const area =
      providedArea !== null && areClose(providedArea, calculatedArea)
        ? providedArea
        : calculatedArea;

    if (!Number.isFinite(area) || area <= 0) continue;

    const newUnitPrice = area * baseUnitPrice;
    if (!Number.isFinite(newUnitPrice) || newUnitPrice <= 0) continue;

    const attributes = [
      buildAttribute("length_mm", line.length?.value ? toMoneyString(length * 1000) : null),
      buildAttribute("width_mm", line.width?.value ? toMoneyString(width * 1000) : null),
      buildAttribute("length", line.length?.value),
      buildAttribute("width", line.width?.value),
      buildAttribute("area", toMoneyString(area)),
    ].filter(Boolean);

    operations.push({
      expand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: line.merchandise.id,
            quantity: line.quantity,
            ...(attributes.length > 0 ? { attributes } : {}),
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: toMoneyString(newUnitPrice),
                },
              },
            },
          },
        ],
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
