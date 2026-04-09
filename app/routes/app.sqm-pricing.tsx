import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

type ProductConfig = {
  id: string;
  title: string;
  handle: string;
  status: string;
  enableSqmPricing: boolean;
  minLength: string;
  maxLength: string;
  minWidth: string;
  maxWidth: string;
};

type LoaderData = {
  products: ProductConfig[];
};

type ActionData = {
  ok: boolean;
  message: string;
};

type ProductMetafieldNode = {
  value: string | null;
} | null;

type ProductNode = {
  id: string;
  title: string;
  handle: string;
  status: string;
  enableSqmPricing: ProductMetafieldNode;
  minLength: ProductMetafieldNode;
  maxLength: ProductMetafieldNode;
  minWidth: ProductMetafieldNode;
  maxWidth: ProductMetafieldNode;
};

type ProductEdge = {
  node: ProductNode;
};

type RowState = {
  key: string;
  productQuery: string;
  productId: string;
  minLength: string;
  maxLength: string;
  minWidth: string;
  maxWidth: string;
};

const DEFAULT_MIN_LENGTH = "0.1";
const DEFAULT_MAX_LENGTH = "100";
const DEFAULT_MIN_WIDTH = "0.1";
const DEFAULT_MAX_WIDTH = "100";
const METAFIELDS_SET_BATCH_LIMIT = 25;
const MAX_PRODUCT_MATCH_OPTIONS = 80;

const PRODUCT_QUERY = `#graphql
  query SqmPricingProducts {
    products(first: 250, sortKey: TITLE) {
      edges {
        node {
          id
          title
          handle
          status
          enableSqmPricing: metafield(namespace: "custom", key: "enable_sqm_pricing") {
            value
          }
          minLength: metafield(namespace: "custom", key: "min_length") {
            value
          }
          maxLength: metafield(namespace: "custom", key: "max_length") {
            value
          }
          minWidth: metafield(namespace: "custom", key: "min_width") {
            value
          }
          maxWidth: metafield(namespace: "custom", key: "max_width") {
            value
          }
        }
      }
    }
  }
`;

const SET_METAFIELDS_MUTATION = `#graphql
  mutation SetSqmMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

function parsePositiveDecimal(value: FormDataEntryValue | null): number | null {
  if (value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  return parsed;
}

function toDecimalString(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded.toString();
}

function buildProductLabel(product: ProductConfig): string {
  return `${product.title} (${product.handle})`;
}

function createEmptyRow(key: string): RowState {
  return {
    key,
    productQuery: "",
    productId: "",
    minLength: DEFAULT_MIN_LENGTH,
    maxLength: DEFAULT_MAX_LENGTH,
    minWidth: DEFAULT_MIN_WIDTH,
    maxWidth: DEFAULT_MAX_WIDTH,
  };
}

function buildInitialRows(products: ProductConfig[]): RowState[] {
  const enabledRows = products
    .filter((product) => product.enableSqmPricing)
    .map((product, index) => ({
      key: `enabled-${index}-${product.id}`,
      productQuery: buildProductLabel(product),
      productId: product.id,
      minLength: product.minLength || DEFAULT_MIN_LENGTH,
      maxLength: product.maxLength || DEFAULT_MAX_LENGTH,
      minWidth: product.minWidth || DEFAULT_MIN_WIDTH,
      maxWidth: product.maxWidth || DEFAULT_MAX_WIDTH,
    }));

  return enabledRows.length > 0 ? enabledRows : [createEmptyRow("row-0")];
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

async function fetchProducts(admin: { graphql: Function }): Promise<ProductConfig[]> {
  const response = await admin.graphql(PRODUCT_QUERY);
  const responseJson = await response.json();
  const edges = (responseJson.data?.products?.edges ?? []) as ProductEdge[];

  return edges.map((edge) => {
    const node = edge.node;

    return {
      id: node.id,
      title: node.title,
      handle: node.handle,
      status: node.status,
      enableSqmPricing: node.enableSqmPricing?.value === "true",
      minLength: node.minLength?.value ?? DEFAULT_MIN_LENGTH,
      maxLength: node.maxLength?.value ?? DEFAULT_MAX_LENGTH,
      minWidth: node.minWidth?.value ?? DEFAULT_MIN_WIDTH,
      maxWidth: node.maxWidth?.value ?? DEFAULT_MAX_WIDTH,
    };
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const products = await fetchProducts(admin);

  return { products } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const rowProductIds = formData.getAll("rowProductId").map((value) => String(value).trim());
  const rowProductQueries = formData
    .getAll("rowProductQuery")
    .map((value) => String(value).trim());
  const rowMinLengths = formData.getAll("rowMinLength");
  const rowMaxLengths = formData.getAll("rowMaxLength");
  const rowMinWidths = formData.getAll("rowMinWidth");
  const rowMaxWidths = formData.getAll("rowMaxWidth");

  const products = await fetchProducts(admin);
  const productMap = new Map(products.map((product) => [product.id, product]));

  const selectedRows = new Map<
    string,
    { minLength: number; maxLength: number; minWidth: number; maxWidth: number }
  >();

  for (let index = 0; index < rowProductIds.length; index += 1) {
    const productId = rowProductIds[index] ?? "";
    const productQuery = rowProductQueries[index] ?? "";

    if (!productId) {
      if (productQuery) {
        return {
          ok: false,
          message: `Row ${index + 1}: choose a product from the dropdown after searching.`,
        } satisfies ActionData;
      }
      continue;
    }

    if (!productMap.has(productId)) {
      return {
        ok: false,
        message: `Row ${index + 1}: selected product is not valid anymore.`,
      } satisfies ActionData;
    }

    if (selectedRows.has(productId)) {
      return {
        ok: false,
        message: `Row ${index + 1}: duplicate product selected. Keep one row per product.`,
      } satisfies ActionData;
    }

    const minLength = parsePositiveDecimal(rowMinLengths[index] ?? null);
    const maxLength = parsePositiveDecimal(rowMaxLengths[index] ?? null);
    const minWidth = parsePositiveDecimal(rowMinWidths[index] ?? null);
    const maxWidth = parsePositiveDecimal(rowMaxWidths[index] ?? null);

    if (minLength === null || maxLength === null || minWidth === null || maxWidth === null) {
      return {
        ok: false,
        message: `Row ${index + 1}: min/max values must be valid numbers greater than 0.`,
      } satisfies ActionData;
    }

    if (minLength > maxLength || minWidth > maxWidth) {
      return {
        ok: false,
        message: `Row ${index + 1}: minimum values must be less than or equal to maximum values.`,
      } satisfies ActionData;
    }

    selectedRows.set(productId, {
      minLength,
      maxLength,
      minWidth,
      maxWidth,
    });
  }

  const metafieldsToSet: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }> = [];

  products.forEach((product) => {
    const selected = selectedRows.get(product.id);

    if (selected) {
      metafieldsToSet.push(
        {
          ownerId: product.id,
          namespace: "custom",
          key: "enable_sqm_pricing",
          type: "boolean",
          value: "true",
        },
        {
          ownerId: product.id,
          namespace: "custom",
          key: "min_length",
          type: "number_decimal",
          value: toDecimalString(selected.minLength),
        },
        {
          ownerId: product.id,
          namespace: "custom",
          key: "max_length",
          type: "number_decimal",
          value: toDecimalString(selected.maxLength),
        },
        {
          ownerId: product.id,
          namespace: "custom",
          key: "min_width",
          type: "number_decimal",
          value: toDecimalString(selected.minWidth),
        },
        {
          ownerId: product.id,
          namespace: "custom",
          key: "max_width",
          type: "number_decimal",
          value: toDecimalString(selected.maxWidth),
        },
      );
      return;
    }

    if (product.enableSqmPricing) {
      metafieldsToSet.push({
        ownerId: product.id,
        namespace: "custom",
        key: "enable_sqm_pricing",
        type: "boolean",
        value: "false",
      });
    }
  });

  for (const batch of chunkArray(metafieldsToSet, METAFIELDS_SET_BATCH_LIMIT)) {
    if (batch.length === 0) continue;

    const response = await admin.graphql(SET_METAFIELDS_MUTATION, {
      variables: { metafields: batch },
    });
    const responseJson = await response.json();
    const userErrors = responseJson.data?.metafieldsSet?.userErrors ?? [];

    if (userErrors.length > 0) {
      return {
        ok: false,
        message: userErrors[0]?.message ?? "Unable to save calculator rows.",
      } satisfies ActionData;
    }
  }

  return {
    ok: true,
    message: `Saved. ${selectedRows.size} product row(s) are now using the calculator.`,
  } satisfies ActionData;
};

export default function SqmPricingPage() {
  const { products } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const productsWithLabel = useMemo(
    () =>
      products.map((product) => ({
        ...product,
        label: buildProductLabel(product),
      })),
    [products],
  );

  const productIdByLabel = useMemo(
    () => new Map(productsWithLabel.map((entry) => [entry.label, entry.id])),
    [productsWithLabel],
  );

  const productById = useMemo(
    () => new Map(productsWithLabel.map((entry) => [entry.id, entry])),
    [productsWithLabel],
  );

  const [rows, setRows] = useState<RowState[]>(() => buildInitialRows(products));

  useEffect(() => {
    setRows(buildInitialRows(products));
  }, [products]);

  function updateRow(key: string, updater: (row: RowState) => RowState) {
    setRows((currentRows) =>
      currentRows.map((row) => {
        if (row.key !== key) return row;
        return updater(row);
      }),
    );
  }

  function addRow() {
    setRows((currentRows) => {
      const nextIndex = currentRows.length;
      return [...currentRows, createEmptyRow(`row-${nextIndex}-${Date.now()}`)];
    });
  }

  function removeRow(key: string) {
    setRows((currentRows) => {
      const filteredRows = currentRows.filter((row) => row.key !== key);
      return filteredRows.length > 0 ? filteredRows : [createEmptyRow("row-0")];
    });
  }

  return (
    <s-page heading="Publish Calculator Rows">
      <s-section>
        <s-paragraph>
          Add one row per product. Search the product, choose it from the dropdown, then set
          min/max dimensions.
        </s-paragraph>
      </s-section>

      {actionData && (
        <s-section>
          <s-banner
            tone={actionData.ok ? "success" : "critical"}
            heading={actionData.ok ? "Rows saved" : "Unable to save rows"}
          >
            <s-paragraph>{actionData.message}</s-paragraph>
          </s-banner>
        </s-section>
      )}

      <s-section heading="Calculator Rows">
        <Form method="post">
          <s-stack direction="block" gap="base">
            {rows.map((row, index) => {
              const normalizedQuery = row.productQuery.trim().toLowerCase();
              const searchMatches = productsWithLabel
                .filter((product) => {
                  if (!normalizedQuery) return true;
                  const haystack = `${product.title} ${product.handle}`.toLowerCase();
                  return haystack.includes(normalizedQuery);
                })
                .slice(0, MAX_PRODUCT_MATCH_OPTIONS);

              const selectedProduct = row.productId ? productById.get(row.productId) : undefined;
              const hasSelectedInMatches = selectedProduct
                ? searchMatches.some((product) => product.id === selectedProduct.id)
                : false;

              const selectOptions = selectedProduct && !hasSelectedInMatches
                ? [selectedProduct, ...searchMatches]
                : searchMatches;

              return (
                <s-box key={row.key} border="base" borderRadius="base" padding="base">
                  <s-stack direction="block" gap="base">
                    <s-heading>Row {index + 1}</s-heading>

                    <s-grid gap="base" gridTemplateColumns="repeat(auto-fit, minmax(18rem, 1fr))">
                      <s-search-field
                        label="Product search"
                        value={row.productQuery}
                        placeholder="Type title or handle"
                        onInput={(event: Event) => {
                          const nextQuery = (event.currentTarget as HTMLInputElement).value;
                          const exactMatchProductId = productIdByLabel.get(nextQuery) ?? "";

                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            productQuery: nextQuery,
                            productId: exactMatchProductId,
                          }));
                        }}
                      />

                      <s-select
                        label="Choose product"
                        value={row.productId}
                        placeholder="Select product"
                        onInput={(event: Event) => {
                          const nextProductId = (event.currentTarget as HTMLInputElement).value;
                          const selected = productById.get(nextProductId);

                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            productId: nextProductId,
                            productQuery: selected ? selected.label : currentRow.productQuery,
                          }));
                        }}
                      >
                        <s-option value="">Select product</s-option>
                        {selectOptions.map((product) => (
                          <s-option key={`${row.key}-${product.id}`} value={product.id}>
                            {product.label}
                          </s-option>
                        ))}
                      </s-select>
                    </s-grid>

                    <s-grid gap="base" gridTemplateColumns="repeat(auto-fit, minmax(12rem, 1fr))">
                      <s-number-field
                        label="Min length (m)"
                        min="0.01"
                        step="0.01"
                        value={row.minLength}
                        onInput={(event: Event) => {
                          const nextValue = (event.currentTarget as HTMLInputElement).value;
                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            minLength: nextValue,
                          }));
                        }}
                      />

                      <s-number-field
                        label="Max length (m)"
                        min="0.01"
                        step="0.01"
                        value={row.maxLength}
                        onInput={(event: Event) => {
                          const nextValue = (event.currentTarget as HTMLInputElement).value;
                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            maxLength: nextValue,
                          }));
                        }}
                      />

                      <s-number-field
                        label="Min width (m)"
                        min="0.01"
                        step="0.01"
                        value={row.minWidth}
                        onInput={(event: Event) => {
                          const nextValue = (event.currentTarget as HTMLInputElement).value;
                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            minWidth: nextValue,
                          }));
                        }}
                      />

                      <s-number-field
                        label="Max width (m)"
                        min="0.01"
                        step="0.01"
                        value={row.maxWidth}
                        onInput={(event: Event) => {
                          const nextValue = (event.currentTarget as HTMLInputElement).value;
                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            maxWidth: nextValue,
                          }));
                        }}
                      />
                    </s-grid>

                    <s-button type="button" variant="secondary" tone="critical" onClick={() => removeRow(row.key)}>
                      Remove row {index + 1}
                    </s-button>

                    <input type="hidden" name="rowProductQuery" value={row.productQuery} />
                    <input type="hidden" name="rowProductId" value={row.productId} />
                    <input type="hidden" name="rowMinLength" value={row.minLength} />
                    <input type="hidden" name="rowMaxLength" value={row.maxLength} />
                    <input type="hidden" name="rowMinWidth" value={row.minWidth} />
                    <input type="hidden" name="rowMaxWidth" value={row.maxWidth} />
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>

          <s-box paddingBlockStart="base">
            <s-stack direction="inline" gap="base">
              <s-button type="button" variant="secondary" onClick={addRow}>
                Add row
              </s-button>
              <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
                Save rows
              </s-button>
            </s-stack>
          </s-box>
        </Form>
      </s-section>
    </s-page>
  );
}
