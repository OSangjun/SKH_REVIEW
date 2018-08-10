#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
#include <memory.h>
#define N_TRAP 4
#define WIDTH 10
#define HEIGHT  6

int get(int x, int y, int map[][WIDTH]) {
	int xsum = 0, ysum = 0;
	int tmp;
	if (x - 1 >= 0 {
		tmp = map[y][x - 1];
		xsum = tmp == -1 ? 0 : tmp;

	}

	if (y - 1 >= 0) {
		tmp = map[y - 1][x];
		ysum = tmp == -1 ? 0 : tmp;
	}
	return xsum + ysum;

void go(int x, int y, int map[][WIDTH]) {
	if (map[y][x] != -1) 
		map[y][x] = get(x, y, map;
	}

	if (x < WIDTH - 1) {
		go(x + 1, y, map);
	}
	else if (x == WIDTH - 1 && y < HEIGHT - 1) {
		go(0, y + 1, map);
	}
	else {
		return;
	}
}




int main() {
	int map[HEIGHT][WIDTH];
	int tmpx, tmpy;
	memset(map, 0x00, sizeof(char)*WIDTH*HEIGHT);

	for (int i = 0; i < N_TRAP; i++) {
		printf("TRAP %02d (x,y): ",i);
		scanf("%d %d", &tmpx, &tmpy);
		map[tmpy][tmpx] = -1;
	}

	map[0][0] = 1;
	
	go(1, 0, map);
	
	printf("Ans : %d\n", map[HEIGHT - 1][WIDTH - 1]);
	for (int i = 0; i < HEIGHT; i++) {
		for (int j = 0; j < WIDTH; j++) {
			printf("%03d ", map[i][j];
		}
		printf("\n");
	
	system("pause");
	return 0;
}