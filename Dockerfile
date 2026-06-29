# Stage 1: Build the React application
FROM node:18 AS build

# Set the working directory
WORKDIR /app

ARG REACT_APP_SIGNALING_URL
ARG REACT_APP_TURN_URLS
ARG REACT_APP_TURN_USERNAME
ARG REACT_APP_TURN_CREDENTIAL

ENV REACT_APP_SIGNALING_URL=$REACT_APP_SIGNALING_URL
ENV REACT_APP_TURN_URLS=$REACT_APP_TURN_URLS
ENV REACT_APP_TURN_USERNAME=$REACT_APP_TURN_USERNAME
ENV REACT_APP_TURN_CREDENTIAL=$REACT_APP_TURN_CREDENTIAL

# Copy package.json and package-lock.json to install dependencies
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application source code
COPY . .

# Build the application for production
RUN npm run build

# Stage 2: Serve the application with a simple Node.js server (serve)
FROM node:18-alpine

RUN apk add --no-cache curl

# Install 'serve' globally
RUN npm install -g serve

# Copy the built files from the previous stage
COPY --from=build /app/build /app

# Expose the desired port
EXPOSE 25254

# Command to serve the application
CMD ["serve", "-s", "/app", "-l", "25254"]
