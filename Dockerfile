# Stage 1: Build the React application
FROM node:18 AS build

# Set the working directory
WORKDIR /app

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

# Install 'serve' globally
RUN npm install -g serve

# Copy the built files from the previous stage
COPY --from=build /app/build /app

# Expose the desired port
EXPOSE 25254

# Command to serve the application
CMD ["serve", "-s", "/app", "-l", "25254"]