FROM alpine:3.19
RUN apk add --no-cache curl
COPY init-hydra-client.sh /scripts/init-hydra-client.sh
RUN chmod +x /scripts/init-hydra-client.sh
CMD ["sh", "/scripts/init-hydra-client.sh"]
