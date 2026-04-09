import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async (_args: LoaderFunctionArgs) => {
  return redirect("/app/sqm-pricing");
};

export default function AppIndexRedirect() {
  return null;
}
