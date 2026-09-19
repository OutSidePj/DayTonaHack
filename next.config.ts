import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@daytona/sdk", "@supabase/supabase-js", "dotenv"],
  agentRules: false,
  devIndicators: false,
};

export default nextConfig;
