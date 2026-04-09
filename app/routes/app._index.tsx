import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const currentUrl = new URL(request.url);
  const queryString = currentUrl.search || "";

  return redirect(`/app/sqm-pricing${queryString}`);
};

export default function AppIndexRedirect() {
  return null;
}
