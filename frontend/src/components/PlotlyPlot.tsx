"use client";

// Prebuilt minified partial bundle (scatter, scatter3d, mesh3d, surface) —
// avoids compiling the full 96MB plotly.js source in dev.
import Plotly from "plotly.js-gl3d-dist-min";
import createPlotlyComponent from "@scatterlab/react-plotly-factory";

const Plot = createPlotlyComponent(Plotly);

export default Plot;
