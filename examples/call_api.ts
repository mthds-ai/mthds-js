import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MthdsApiClient } from "../src/client/index.js";

async function main() {
  const bundlePath = resolve(import.meta.dirname!, "gantt.toml");
  const mthdsContent = readFileSync(bundlePath, "utf-8");

  const client = new MthdsApiClient({
    apiBaseUrl: "http://127.0.0.1:8081",
    apiToken: "test-api-key",
  });

  console.log("Executing pipeline...");

  const response = await client.executePipeline({
    mthds_content: mthdsContent,
    inputs: {
      gantt_chart_image: {
        concept: "gantt.GanttChartImage",
        content: {
          url: "https://pipelex-web.s3.us-west-2.amazonaws.com/cookbook/gantt_tree_house.png",
        },
      },
    },
  });

  console.log("Pipeline state:", response.pipeline_state);
  console.log("Pipeline run ID:", response.pipeline_run_id);

  if (response.pipe_output) {
    console.log(
      "Output:",
      JSON.stringify(response.pipe_output, null, 2)
    );
  }
}

main().catch(console.error);
