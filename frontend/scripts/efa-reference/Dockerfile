FROM rocker/r-ver:4.5.1@sha256:03b023fbf7b1b24ac1bb8b2ac5fd7e15a767e67b40ff50c155e328110981c2aa
COPY install.R /opt/efa/install.R
RUN Rscript /opt/efa/install.R
COPY generate.R /opt/efa/generate.R
ENTRYPOINT ["Rscript", "/opt/efa/generate.R"]
